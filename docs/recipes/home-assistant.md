# Home Assistant

Two ways to get events into Home Assistant, both using only built-in integrations:

- **MQTT (recommended).** Each modem shows up as a device with signal, operator, SIM and connectivity entities, and you can trigger on SMS and calls. It needs an MQTT broker, e.g. the Mosquitto add-on.
- **Webhook.** No broker needed, but events only, no entities. See [below](#alternative-webhook-triggers).

Sending SMS and ringing phones goes through the REST API with `rest_command` either way.

## MQTT setup

1. Install the **Mosquitto broker** add-on (or use any broker) and create a Home Assistant user for gsm2http, e.g. `gsm2http`.
2. Make sure the **MQTT** integration is set up in Home Assistant (*Settings → Devices & services*).
3. Point gsm2http at the broker:

   ```sh
   # .env
   MQTT_URL=mqtt://homeassistant.local:1883
   MQTT_USERNAME=gsm2http
   MQTT_PASSWORD=replace-me
   MQTT_HA_DISCOVERY=true
   ```

   Or, in a [config file](../events.md#config-file):

   ```yaml
   notifiers:
     - type: mqtt
       name: home-assistant
       url: mqtt://homeassistant.local:1883
       username: gsm2http
       password: ${MQTT_PASSWORD}
       homeAssistant: { discovery: true }
   ```

4. Restart gsm2http. Each modem now appears under *Settings → Devices & services → MQTT* as a device named after its model, keyed by IMEI so it survives restarts:

| Entity | What it shows |
|---|---|
| `sensor.<modem>_signal` | Signal strength, % |
| `sensor.<modem>_operator` | Network operator |
| `sensor.<modem>_sim_status` | `READY`, `SIM PIN`, `NO SIM`, … |
| `binary_sensor.<modem>_connected` | Whether the modem is plugged in and answering |
| `event.<modem>_sms` | Fires `sms.received`, with `sender` and `text` attributes |
| `event.<modem>_incoming_call` | Fires `call.incoming` once per call, with `number` and `call_id` |

All of them become *unavailable* when gsm2http stops (the `gsm2http/status` last will).

Topics are `gsm2http/<modemId>/<family>/<action>`, and each payload is the event [envelope](../events.md#the-envelope-schema-version-1). Watch them under *Settings → Devices & services → MQTT → Configure → Listen to a topic* with `gsm2http/#`.

## Automations

### Notify on every SMS

```yaml
# automations.yaml
- alias: "SMS received: notify phone"
  triggers:
    - trigger: mqtt
      topic: gsm2http/+/sms/received
  actions:
    - action: notify.mobile_app_your_phone
      data:
        title: "SMS from {{ trigger.payload_json.data.sender }}"
        message: "{{ trigger.payload_json.data.text }}"
```

`+` matches every modem. Use `gsm2http/modem-1/sms/received` for one.

### Doorbell line: lights on when a specific number calls

`call.incoming` fires once per call, so no de-duplication is needed:

```yaml
- alias: "Doorbell line is ringing"
  triggers:
    - trigger: mqtt
      topic: gsm2http/+/call/incoming
  conditions:
    - condition: template
      value_template: "{{ trigger.payload_json.data.number == '+12025550199' }}"
  actions:
    - action: light.turn_on
      target: { entity_id: light.hallway }
```

### Missed-call log

```yaml
- alias: "Missed call: logbook"
  triggers:
    - trigger: mqtt
      topic: gsm2http/+/call/ended
  conditions:
    - condition: template
      value_template: "{{ trigger.payload_json.data.reason == 'missed' }}"
  actions:
    - action: logbook.log
      data:
        name: gsm2http
        message: >-
          Missed call from {{ trigger.payload_json.data.number or 'withheld' }}
          ({{ trigger.payload_json.data.rings }} rings)
```

### Alert when the modem goes away

```yaml
- alias: "gsm2http modem offline"
  triggers:
    - trigger: state
      entity_id: binary_sensor.huawei_e173_connected   # yours will be named after your modem
      to: "off"
      for: "00:05:00"
  actions:
    - action: notify.mobile_app_your_phone
      data:
        message: "The GSM modem has been disconnected for 5 minutes"
```

With discovery on, you can also trigger on the event entities (`event.huawei_e173_sms`) from the automation editor's *Entity → State* trigger. Their `sender`, `text` and `number` attributes hold the details.

## Send SMS and ring a phone

```yaml
# configuration.yaml
rest_command:
  gsm2http_ring:
    url: "http://gsm2http.local:9333/api/modems/modem-1/dial"
    method: POST
    headers:
      Authorization: !secret gsm2http_bearer   # "Bearer <API_TOKEN>"
    content_type: "application/json"
    payload: '{"to": "{{ to }}", "durationSeconds": {{ seconds | default(20) }}}'

  gsm2http_sms:
    url: "http://gsm2http.local:9333/api/modems/modem-1/sms"
    method: POST
    headers:
      Authorization: !secret gsm2http_bearer
    content_type: "application/json"
    payload: '{"to": "{{ to }}", "text": {{ text | tojson }}}'
```

```yaml
# secrets.yaml
gsm2http_bearer: "Bearer replace-with-your-api-token"
```

Use them in an alarm automation:

```yaml
actions:
  - action: rest_command.gsm2http_ring
    data:
      to: "+12025550199"
      seconds: 30
  - action: rest_command.gsm2http_sms
    data:
      to: "+12025550199"
      text: "Alarm triggered at {{ now().strftime('%H:%M') }}"
```

Use the modem's IMEI instead of `modem-1` in the URL if you have more than one. IDs follow discovery order.

## Alternative: webhook triggers

Without a broker, send events to a Home Assistant webhook instead:

1. Choose a hard-to-guess webhook ID, e.g. `gsm2http-4b9e1d`.
2. Set `WEBHOOK_URL=http://homeassistant.local:8123/api/webhook/gsm2http-4b9e1d`.
3. Trigger on it and filter on `event`:

```yaml
- alias: "SMS received (webhook)"
  triggers:
    - trigger: webhook
      webhook_id: gsm2http-4b9e1d
      allowed_methods: [POST]
      local_only: true
  conditions:
    - condition: template
      value_template: "{{ trigger.json.event == 'sms.received' }}"
  actions:
    - action: notify.mobile_app_your_phone
      data:
        title: "SMS from {{ trigger.json.data.sender }}"
        message: "{{ trigger.json.data.text }}"
```

Home Assistant webhook triggers can't check gsm2http's HMAC signature, so the webhook ID is the only secret. Keep `local_only: true`, which blocks the webhook from Nabu Casa and your external URL, unless gsm2http runs outside your LAN.

## Coming from the removed `sms` integration

Home Assistant removed its Gammu-based `sms` integration in late 2025. With gsm2http:

| Old | New |
|---|---|
| `notify.sms` | `rest_command.gsm2http_sms` |
| `sms.incoming_sms` event | An MQTT trigger on `gsm2http/+/sms/received`, or the `event.<modem>_sms` entity |
| Signal sensor | `sensor.<modem>_signal`, from MQTT discovery |

Pass the modem through to the gsm2http container, not to Home Assistant. Only one program can use the AT port at a time.
