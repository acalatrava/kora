---
name: homeassistant-mqtt
description: Integrates Kora with Home Assistant via MQTT discovery. Registers as a device in HA and allows sending commands, querying status, and creating automated tasks. Use when the user asks about home automation, smart home control, or Home Assistant.
metadata:
  author: Kora
  version: "1.0"
compatibility: Requires an MQTT broker (e.g., Mosquitto) and Home Assistant with MQTT integration configured.
---

# Home Assistant MQTT Integration

This skill enables Kora to appear as a device in Home Assistant through MQTT discovery.

## Setup

1. Ensure you have an MQTT broker running (e.g., Mosquitto)
2. Configure Home Assistant's MQTT integration
3. Configure the MQTT broker URL in Kora settings (`ha_broker_url`)
4. Enable the `homeassistant_mqtt` tool in settings

## What it does

- Registers Kora as a device in Home Assistant with sensor and switch entities
- Allows sending commands to HA entities via MQTT
- Queries entity status
- Creates scheduled tasks that can be triggered from HA automations

## MQTT Topics

- Discovery: `homeassistant/sensor/korabot/config`
- Command: `korabot/command`
- Status: `korabot/status`
- Availability: `korabot/availability`

## Usage

The Home Assistant integration is handled by the built-in `homeassistant_mqtt` tool, not by this skill directly. This skill provides reference documentation for the integration.

To interact with Home Assistant entities, use the built-in tools:
- `ha_send_command` — Send a command to an entity (e.g., turn on a light)
- `ha_get_status` — Query the status of an entity
- `ha_create_task` — Create a scheduled task triggered by HA
