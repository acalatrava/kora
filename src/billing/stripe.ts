import Stripe from 'stripe';
import { logger } from '../core/logger.js';
import type { UserManager } from '../core/user.js';
import type { WorkspaceManager } from '../core/workspace.js';
import type { IdentityManager } from '../core/identity.js';

const SCOPE = 'stripe';

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  priceId: string;
  portalConfigId?: string;
  baseUrl: string;
}

export type TelegramNotifyFn = (chatId: number, text: string) => Promise<void>;

export class StripeManager {
  private stripe: Stripe;
  private config: StripeConfig;
  private userManager: UserManager;
  private workspaceManager: WorkspaceManager;
  private identityManager: IdentityManager;
  private telegramNotify?: TelegramNotifyFn;

  constructor(
    config: StripeConfig,
    userManager: UserManager,
    workspaceManager: WorkspaceManager,
    identityManager: IdentityManager,
  ) {
    this.stripe = new Stripe(config.secretKey);
    this.config = config;
    this.userManager = userManager;
    this.workspaceManager = workspaceManager;
    this.identityManager = identityManager;
  }

  setTelegramNotify(fn: TelegramNotifyFn): void {
    this.telegramNotify = fn;
  }

  async createCheckoutSession(email: string, regCode: string, telegramChatId: string): Promise<string> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{ price: this.config.priceId, quantity: 1 }],
      success_url: `${this.config.baseUrl}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${this.config.baseUrl}/?canceled=true`,
      metadata: { regCode, telegramChatId, email, source: 'legacy' },
      subscription_data: { metadata: { telegramChatId, source: 'legacy' } },
    });

    logger.info(SCOPE, `Created checkout session for ${email}`);
    return session.url!;
  }

  async createTelegramCheckoutSession(telegramChatId: string): Promise<string> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: this.config.priceId, quantity: 1 }],
      success_url: `${this.config.baseUrl}/?subscription=active`,
      cancel_url: `${this.config.baseUrl}/?canceled=true`,
      metadata: { telegramChatId, source: 'telegram' },
      subscription_data: { metadata: { telegramChatId, source: 'telegram' } },
    });

    logger.info(SCOPE, `Created Telegram checkout session for chat ${telegramChatId}`);
    return session.url!;
  }

  async createPortalCheckoutSession(userId: string): Promise<string> {
    const user = this.userManager.getById(userId);
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      ...(user?.email ? { customer_email: user.email } : {}),
      line_items: [{ price: this.config.priceId, quantity: 1 }],
      success_url: `${this.config.baseUrl}/?subscription=active`,
      cancel_url: `${this.config.baseUrl}/?canceled=true`,
      metadata: { userId, source: 'portal' },
      subscription_data: { metadata: { userId, source: 'portal' } },
    });

    logger.info(SCOPE, `Created portal checkout session for user ${userId}`);
    return session.url!;
  }

  async createPortalSession(customerId: string): Promise<string> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${this.config.baseUrl}/`,
      ...(this.config.portalConfigId ? { configuration: this.config.portalConfigId } : {}),
    });

    return session.url;
  }

  async handleWebhook(rawBody: Buffer, signature: string): Promise<void> {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.config.webhookSecret);
    } catch (err) {
      logger.error(SCOPE, `Webhook signature verification failed: ${(err as Error).message}`);
      throw err;
    }

    logger.info(SCOPE, `Webhook event: ${event.type}`);

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        await this.handleCheckoutComplete(session);
        break;
      }
      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        const invCustomer = (invoice as unknown as Record<string, unknown>).customer;
        if (invCustomer) {
          const user = this.findUserByCustomerId(String(invCustomer));
          if (user) {
            this.userManager.updateSubscription(user.id, { subscriptionStatus: 'active' });
            logger.info(SCOPE, `Invoice paid for user ${user.id}`);
          } else {
            await this.handleInvoicePaidNoUser(invoice, String(invCustomer));
          }
        }
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const failedCustomer = (invoice as unknown as Record<string, unknown>).customer;
        if (failedCustomer) {
          const user = this.findUserByCustomerId(String(failedCustomer));
          if (user) {
            this.userManager.updateSubscription(user.id, { subscriptionStatus: 'past_due' });
            logger.warn(SCOPE, `Payment failed for user ${user.id}`);
          }
        }
        break;
      }
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const user = this.findUserByCustomerId(String(subscription.customer));
        if (user) {
          const status = subscription.status === 'active' ? 'active'
            : subscription.status === 'past_due' ? 'past_due' : 'canceled';
          this.userManager.updateSubscription(user.id, {
            subscriptionStatus: status as 'active' | 'past_due' | 'canceled',
            stripeSubscriptionId: subscription.id,
          });
          logger.info(SCOPE, `Subscription updated for user ${user.id}: ${status}`);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const user = this.findUserByCustomerId(String(subscription.customer));
        if (user) {
          this.userManager.updateSubscription(user.id, { subscriptionStatus: 'canceled' });
          logger.info(SCOPE, `Subscription canceled for user ${user.id}`);
        }
        break;
      }
    }
  }

  private async handleCheckoutComplete(session: Stripe.Checkout.Session): Promise<void> {
    const meta = session.metadata || {};
    const source = meta.source || 'legacy';
    const customerId = String(session.customer);
    const subscriptionId = String(session.subscription);
    const sessionEmail = session.customer_details?.email || session.customer_email || meta.email;

    if (source === 'telegram') {
      await this.handleTelegramCheckout(meta.telegramChatId, sessionEmail, customerId, subscriptionId);
      return;
    }

    if (source === 'portal') {
      await this.handlePortalCheckout(meta.userId, sessionEmail, customerId, subscriptionId);
      return;
    }

    await this.handleLegacyCheckout(meta, sessionEmail, customerId, subscriptionId);
  }

  private async handleTelegramCheckout(
    telegramChatId: string | undefined,
    email: string | null | undefined,
    customerId: string,
    subscriptionId: string,
  ): Promise<void> {
    if (!telegramChatId) {
      logger.warn(SCOPE, 'Telegram checkout missing telegramChatId');
      return;
    }

    const tgIdentityId = `telegram:${telegramChatId}`;
    const identity = this.identityManager.resolve('telegram', tgIdentityId);
    if (!identity?.workspaceId) {
      logger.warn(SCOPE, `No workspace found for telegram chat ${telegramChatId}`);
      return;
    }

    const ws = this.workspaceManager.get(identity.workspaceId);
    let userId = ws?.ownerUserId;

    if (userId) {
      logger.info(SCOPE, `Workspace ${identity.workspaceId} already has owner ${userId}, updating subscription`);
    } else if (email) {
      const existingUser = this.userManager.getByEmail(email);
      if (existingUser) {
        userId = existingUser.id;
      } else {
        const tempPassword = Array.from(crypto.getRandomValues(new Uint8Array(16)))
          .map(b => b.toString(16).padStart(2, '0')).join('');
        const user = await this.userManager.create(email, tempPassword);
        userId = user.id;
      }

      this.workspaceManager.setOwner(identity.workspaceId, userId);
      this.identityManager.linkToUser(identity.id, userId, identity.workspaceId);
    } else {
      logger.warn(SCOPE, `Telegram checkout for chat ${telegramChatId}: no owner and no email, cannot activate subscription`);
    }

    if (userId) {
      this.userManager.updateSubscription(userId, {
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: 'active',
        subscriptionStartDate: new Date(),
      });
      logger.info(SCOPE, `Telegram checkout complete: user ${userId} subscription activated`);
    }

    if (this.telegramNotify) {
      try {
        await this.telegramNotify(
          Number(telegramChatId),
          '✅ <b>Subscription activated!</b>\n\nYour subscription is now active. You can start using the AI agent.',
        );
      } catch (err) {
        logger.warn(SCOPE, `Failed to notify telegram chat ${telegramChatId}: ${(err as Error).message}`);
      }
    }
  }

  private async handlePortalCheckout(
    userId: string | undefined,
    email: string | null | undefined,
    customerId: string,
    subscriptionId: string,
  ): Promise<void> {
    if (!userId) {
      logger.warn(SCOPE, 'Portal checkout missing userId');
      return;
    }

    this.userManager.updateSubscription(userId, {
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus: 'active',
      subscriptionStartDate: new Date(),
    });

    logger.info(SCOPE, `Portal checkout complete: user ${userId} subscription activated`);
  }

  private async handleLegacyCheckout(
    meta: Record<string, string>,
    email: string | null | undefined,
    customerId: string,
    subscriptionId: string,
  ): Promise<void> {
    const { regCode, telegramChatId } = meta;
    if (!regCode || !telegramChatId || !email) {
      logger.warn(SCOPE, 'Legacy checkout session missing metadata');
      return;
    }

    const code = this.userManager.validateRegistrationCode(regCode);
    if (!code) {
      logger.warn(SCOPE, `Registration code ${regCode} invalid at checkout completion`);
      return;
    }

    const existingUser = this.userManager.getByEmail(email);
    if (existingUser) {
      this.userManager.updateSubscription(existingUser.id, {
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: 'active',
        subscriptionStartDate: new Date(),
      });
      return;
    }

    const tempPassword = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    const user = await this.userManager.create(email, tempPassword);
    const workspace = this.workspaceManager.create(email.split('@')[0], false, user.id);

    const identity = this.identityManager.create('telegram', telegramChatId, workspace.id, user.id);
    this.identityManager.linkToUser(identity.id, user.id, workspace.id);

    this.userManager.updateSubscription(user.id, {
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus: 'active',
      subscriptionStartDate: new Date(),
    });

    this.userManager.markRegistrationCodeUsed(regCode, user.id);
    logger.info(SCOPE, `Legacy checkout complete: user ${user.id} created with subscription`);
  }

  private async handleInvoicePaidNoUser(invoice: Stripe.Invoice, customerId: string): Promise<void> {
    const inv = invoice as unknown as Record<string, unknown>;
    const rawSub = inv.subscription;
    const subscriptionId = typeof rawSub === 'string'
      ? rawSub
      : (rawSub as Record<string, unknown> | null)?.id as string | undefined;

    if (!subscriptionId) {
      logger.warn(SCOPE, `invoice.paid: no subscription ID, cannot resolve user (customer ${customerId})`);
      return;
    }

    let subMeta: Record<string, string> = {};
    try {
      const sub = await this.stripe.subscriptions.retrieve(subscriptionId);
      subMeta = (sub.metadata || {}) as Record<string, string>;
    } catch (err) {
      logger.warn(SCOPE, `invoice.paid: failed to retrieve subscription ${subscriptionId}: ${(err as Error).message}`);
    }

    const invoiceEmail = invoice.customer_email
      || (inv.customer_details as Record<string, unknown> | null)?.email as string | undefined;

    const source = subMeta.source;
    const telegramChatId = subMeta.telegramChatId;

    if (source === 'telegram' && telegramChatId) {
      logger.info(SCOPE, `invoice.paid: handling as Telegram checkout fallback for chat ${telegramChatId}`);
      await this.handleTelegramCheckout(telegramChatId, invoiceEmail, customerId, subscriptionId);
      return;
    }

    if (source === 'portal' && subMeta.userId) {
      logger.info(SCOPE, `invoice.paid: handling as portal checkout fallback for user ${subMeta.userId}`);
      await this.handlePortalCheckout(subMeta.userId, invoiceEmail, customerId, subscriptionId);
      return;
    }

    if (invoiceEmail) {
      const existingUser = this.userManager.getByEmail(invoiceEmail);
      if (existingUser) {
        this.userManager.updateSubscription(existingUser.id, {
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
          subscriptionStatus: 'active',
          subscriptionStartDate: new Date(),
        });
        logger.info(SCOPE, `invoice.paid: matched user ${existingUser.id} by email ${invoiceEmail}`);
        return;
      }
    }

    logger.warn(SCOPE, `invoice.paid: could not resolve user for customer ${customerId} (source=${source || 'unknown'}, email=${invoiceEmail || 'none'})`);
  }

  private findUserByCustomerId(customerId: string): { id: string } | null {
    const users = this.userManager.listAll();
    return users.find(u => u.stripeCustomerId === customerId) || null;
  }
}
