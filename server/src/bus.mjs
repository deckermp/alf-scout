// src/bus.mjs — in-process event bus + Server-Sent-Events fan-out. No app imports.
import { EventEmitter } from "node:events";

export const bus = new EventEmitter();
bus.setMaxListeners(0);

const clients = new Set();

export function addClient(res) {
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

// Broadcast any object to every connected SSE client. The frame is flattened —
// `broadcast("research", {event})` arrives as {type:"research", event:{…}}.
export function broadcast(type, payload) {
  const frame = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
  bus.emit(type, payload);
}
