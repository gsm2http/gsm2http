# Multi-Modem & Live Call Audio Plan

> Historical design note carried over from the pre-open-source prototype. Multi-modem support (part A) has since been implemented; the live call audio pipeline (parts B–C) is still exploratory.

## 1. Goal
Support multiple 3G modems concurrently (Huawei E173 for Voice+SMS, Huawei E3372 for SMS) and implement a live call listening/recording feature via a webhook (e.g., n8n) that directs the user to a frontend UI to join the call.

## 2. Context & Constraints
*   **Hardware:** 
    *   Huawei E173 supports Voice calls (CS) and SMS. Voice audio requires routing PCM data over a USB serial port via `AT^CVOICE=0`.
    *   Huawei E3372 supports SMS only (no voice).
*   **Current Architecture:** 
    *   Backend (`ModemStream.ts`) auto-binds to the *first* responding `/dev/ttyUSB*` port.
    *   Express/Socket.io backend exposes APIs and emits raw AT events.
*   **Constraint:** Audio extraction from the E173 over USB serial is highly hardware/firmware specific and requires decoding raw PCM hex data and streaming it to the frontend (likely via WebSockets/WebRTC).

## 3. Architecture & Data Flow

### A. Dynamic Modem Discovery & Role Assignment
1.  **Refactor `ModemStream` into `ModemManager`:** 
    *   Scan all available `/dev/ttyUSB*` ports.
    *   Send `ATE0` to check for AT responsiveness.
    *   Send `AT+CGMM` to determine the model (E173 vs E3372).
    *   Assign roles: E173 gets `Capabilities: [VOICE, SMS]`, E3372 gets `Capabilities: [SMS]`.
    *   Maintain a map of active modems and their respective ports.
2.  **API Updates:** 
    *   Update REST APIs to target specific modems (e.g., `/api/modem/:modemId/network`).
    *   Socket.io events must include the `modemId` (e.g., `sms_received` with `modemId: "E173"`).

### B. Live Call Webhook & UI Flow
1.  **Incoming Call Event:**
    *   E173 receives `RING` and `+CLIP` (Caller ID).
    *   Backend emits `call_received` via Socket.io and fires the webhook (n8n).
2.  **Notification & Join:**
    *   n8n sends a push notification (e.g., Telegram) containing a link to the frontend: `http://frontend-url/call?modemId=E173&number=+123456789`.
3.  **Frontend Call UI:**
    *   Frontend displays a "Join Call" view for the specific modem.
    *   User clicks "Join". Frontend emits a Socket.io event: `answer_call { modemId: "E173" }`.

### C. Audio Pipeline (The Hard Part)
1.  **Answering:** Backend receives `answer_call`, sends `ATA` to the E173.
2.  **Audio Routing:** Backend sends `AT^CVOICE=0` to route audio to the diagnostic/PCUI serial port.
3.  **Capture & Stream:** 
    *   Backend reads the raw PCM data from the serial port.
    *   Backend streams this data via WebSocket to the frontend.
4.  **Playback & Record:** 
    *   Frontend receives the audio stream, decodes the PCM, and plays it via the Web Audio API.
    *   Frontend UI includes a "Record" button to capture the incoming stream and save it locally (e.g., via `MediaRecorder`).

## 4. Open Decisions / Questions

1.  **Audio upstream (microphone):** the plan covers *listening to* and *recording* the caller. Whether audio should also go *back* to the caller (two-way) is undecided.

## 5. Execution Steps

1.  **Step 1: ModemManager Refactor.** Update backend to detect, identify via `AT+CGMM`, and manage multiple modems simultaneously. Update frontend to display multiple modems.
2.  **Step 2: Webhook & Join Call Flow.** Ensure webhook payload includes `modemId` and caller number. Build the frontend "Join Call" view that triggers the `ATA` answer command.
3.  **Step 3: Audio Spike.** Conduct an isolated test to verify the E173's firmware supports `AT^CVOICE=0` and successfully outputs raw audio data on a secondary port.
4.  **Step 4: Audio Streaming & Playback.** If Step 3 succeeds, implement the PCM decoding, WebSocket streaming, and frontend Web Audio playback/recording pipeline.

## 6. Risks
*   **Hardware/Firmware Limitations:** The E173 firmware might not support USB audio routing, or it might require a specific, undocumented AT command sequence to enable it. If it fails, capturing audio requires physically tapping the speaker pins on the modem.