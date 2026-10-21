# Scripts

## curl

```sh
export GSM2HTTP=http://127.0.0.1:9333
export AUTH="Authorization: Bearer $API_TOKEN"

curl -s -H "$AUTH" $GSM2HTTP/api/modems | jq '.modems[] | {id, model, simStatus, signalPercentage}'

# Unlock a SIM (three wrong PINs lock it, so double-check the PIN first)
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"pin":"0000"}' $GSM2HTTP/api/modems/modem-2/unlock

# Ring for 15 s and wait until the call has ended
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"to":"+12025550199","durationSeconds":15,"sync":true}' $GSM2HTTP/api/modems/modem-1/dial

# Hang up early
curl -s -X POST -H "$AUTH" $GSM2HTTP/api/modems/modem-1/hangup

# Send an SMS (an sms.sent event follows)
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: backup-$(date +%F)" \
  -d '{"to":"+12025550199","text":"Nightly backup OK"}' $GSM2HTTP/api/modems/modem-1/sms
```

## Receive events

Webhook receivers in Node.js and Python that verify signatures, plus a curl script that sends a signed test event, are in [receivers.md](receivers.md).

To watch events without writing a receiver, subscribe over MQTT:

```sh
mosquitto_sub -h broker.local -t 'gsm2http/#' -v
```

## Simulate events (mock mode)

With `MOCK_MODE=true`, these inject events that go through the full pipeline (decoder, event bus, webhooks, MQTT):

```sh
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"modemId":"modem-1","sender":"+12025550199","text":"test"}' $GSM2HTTP/api/mock/sms

# One ring; call.ended (reason "missed") follows about 10 s later
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"modemId":"modem-1","number":"+12025550188"}' $GSM2HTTP/api/mock/call
```

## Check delivery

```sh
# Configured sinks and the last delivery attempts (no message content)
curl -s -H "$AUTH" $GSM2HTTP/api/notifiers | jq '.notifiers[] | {name, type, target, stats}'
curl -s -H "$AUTH" $GSM2HTTP/api/notifiers | jq -r '.deliveries[] | [.at, .notifier, .event, .outcome, (.status // "")] | @tsv'
```

## Is the modem still alive? (cron)

```sh
#!/bin/sh
# /etc/cron.hourly/gsm2http-check: complain if no modem has a ready SIM
ready=$(curl -fsS -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:9333/api/modems \
  | jq '[.modems[] | select(.connected and .simStatus == "READY")] | length')
[ "${ready:-0}" -ge 1 ] || echo "gsm2http: no modem with a ready SIM" | mail -s "gsm2http down" root
```

Prepaid SIMs often expire after months without activity. Many people send themselves one SMS a month to keep the SIM active.
