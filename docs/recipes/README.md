# Recipes

Short, copy-pasteable integrations. Each assumes gsm2http is running at `http://127.0.0.1:9333` (or wherever you put it) and that `API_TOKEN` holds your token.

| Recipe | What it does |
|---|---|
| [n8n](n8n.md) | Receive SMS and calls in a workflow, verify the webhook signature, reply by SMS or ring a phone through the REST API |
| [Home Assistant](home-assistant.md) | MQTT discovery (each modem as a device with signal, SIM and event entities), automations on SMS and calls, `rest_command` to send SMS and ring, all with built-in integrations |
| [Node-RED](node-red.md) | Flows that receive events over MQTT or a webhook and call the API |
| [Webhook receivers](receivers.md) | Node.js and Python receivers that verify signatures, and a curl script that sends a signed test event |
| [Scripts](scripts.md) | `curl` against the API, mock events, delivery checks, and a cron job for "is my modem still alive?" |

Events, payloads, delivery and signatures are specified in [events.md](../events.md). All recipes use schema version 1 of the event envelope.

Have an integration that works for you? A pull request adding a recipe is very welcome. Please use fake numbers (`+1 202 555 01xx`) and `example` hostnames.
