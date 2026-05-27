import type { ToolDefinition } from '../core/types.js';
import { logger } from '../core/logger.js';

const SCOPE = 'ha-tool';

export interface HomeAssistantToolContext {
  haUrl: string;
  haToken: string;
}

async function haFetch(
  ctx: HomeAssistantToolContext,
  path: string,
  opts?: RequestInit,
): Promise<Response> {
  const url = `${ctx.haUrl.replace(/\/+$/, '')}${path}`;
  return fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${ctx.haToken}`,
      'Content-Type': 'application/json',
      ...opts?.headers,
    },
  });
}

export const homeAssistantToolDefinitions: ToolDefinition[] = [
  {
    name: 'ha_get_states',
    description:
      'Query Home Assistant entity states via REST API. Returns full state with attributes. Omit entity_id to list all entities.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: {
          type: 'string',
          description:
            'Entity ID (e.g. "light.living_room"). Omit to get all entities.',
        },
      },
    },
  },
  {
    name: 'ha_call_service',
    description:
      'Call a Home Assistant service via REST API (e.g. turn_on, turn_off, toggle, set_temperature).',
    parameters: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Service domain (e.g. "light", "switch", "climate", "automation").',
        },
        service: {
          type: 'string',
          description: 'Service name (e.g. "turn_on", "turn_off", "toggle").',
        },
        service_data: {
          type: 'object',
          description:
            'Service data payload. Usually includes entity_id and optional parameters like brightness, temperature, etc.',
        },
      },
      required: ['domain', 'service'],
    },
  },
  {
    name: 'ha_list_services',
    description:
      'List available Home Assistant services per domain. Useful for discovering what actions are available.',
    parameters: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description:
            'Filter by domain (e.g. "light"). Omit to list all domains and services.',
        },
      },
    },
  },
];

export async function handleHomeAssistantTool(
  name: string,
  args: Record<string, unknown>,
  context: HomeAssistantToolContext,
): Promise<string> {
  try {
    switch (name) {
      case 'ha_get_states': {
        const entityId = args.entity_id as string | undefined;
        const path = entityId ? `/api/states/${entityId}` : '/api/states';
        const res = await haFetch(context, path);

        if (!res.ok) {
          const body = await res.text();
          logger.error(SCOPE, `ha_get_states failed (${res.status}): ${body}`);
          return JSON.stringify({ ok: false, error: `HA API returned ${res.status}: ${body}` });
        }

        const data = await res.json();

        if (entityId) {
          return JSON.stringify({
            ok: true,
            entity_id: (data as Record<string, unknown>).entity_id,
            state: (data as Record<string, unknown>).state,
            attributes: (data as Record<string, unknown>).attributes,
            last_changed: (data as Record<string, unknown>).last_changed,
          });
        }

        const entities = (data as Array<Record<string, unknown>>).map((e) => ({
          entity_id: e.entity_id,
          state: e.state,
          friendly_name: (e.attributes as Record<string, unknown>)?.friendly_name,
        }));
        return JSON.stringify({ ok: true, count: entities.length, entities });
      }

      case 'ha_call_service': {
        const domain = args.domain as string;
        const service = args.service as string;
        const serviceData = (args.service_data as Record<string, unknown>) || {};

        const res = await haFetch(context, `/api/services/${domain}/${service}`, {
          method: 'POST',
          body: JSON.stringify(serviceData),
        });

        if (!res.ok) {
          const body = await res.text();
          logger.error(SCOPE, `ha_call_service failed (${res.status}): ${body}`);
          return JSON.stringify({ ok: false, error: `HA API returned ${res.status}: ${body}` });
        }

        const result = await res.json();
        const affected = Array.isArray(result)
          ? (result as Array<Record<string, unknown>>).map((e) => e.entity_id)
          : [];

        logger.info(SCOPE, `Called ${domain}.${service} — affected: ${affected.join(', ') || 'none'}`);
        return JSON.stringify({
          ok: true,
          message: `Service ${domain}.${service} called successfully`,
          affected_entities: affected,
        });
      }

      case 'ha_list_services': {
        const domainFilter = args.domain as string | undefined;
        const res = await haFetch(context, '/api/services');

        if (!res.ok) {
          const body = await res.text();
          logger.error(SCOPE, `ha_list_services failed (${res.status}): ${body}`);
          return JSON.stringify({ ok: false, error: `HA API returned ${res.status}: ${body}` });
        }

        const data = (await res.json()) as Array<{ domain: string; services: Record<string, unknown> }>;

        if (domainFilter) {
          const entry = data.find((d) => d.domain === domainFilter);
          if (!entry) {
            return JSON.stringify({ ok: true, domain: domainFilter, services: [], message: 'Domain not found' });
          }
          return JSON.stringify({
            ok: true,
            domain: domainFilter,
            services: Object.keys(entry.services),
          });
        }

        const summary = data.map((d) => ({
          domain: d.domain,
          services: Object.keys(d.services),
        }));
        return JSON.stringify({ ok: true, count: summary.length, domains: summary });
      }

      default:
        return JSON.stringify({ ok: false, error: `Unknown HA tool: ${name}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(SCOPE, `${name} failed: ${msg}`);
    return JSON.stringify({ ok: false, error: msg });
  }
}
