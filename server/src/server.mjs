// src/server.mjs — standalone entry point for the ALF research pipeline.
//
// Extracted from a larger private agent harness, where this feature mounted onto
// an existing ledger server. Here it is the whole app: the research router, an
// SSE stream, and a health check.
import express from "express";
import cors from "cors";
import { addClient } from "./bus.mjs";
import { research } from "./routes/research.mjs";

const PORT = Number(process.env.PORT || 4747);
// Loopback by default: the research routes are unauthenticated and can spend
// real model tokens. Set HOST explicitly to expose it.
const HOST = process.env.HOST || "127.0.0.1";

const app = express();
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN?.split(",").map((s) => s.trim()) || [
    "http://localhost:5173", "http://127.0.0.1:5173",
    "http://localhost:4748", "http://127.0.0.1:4748",
  ],
}));
app.use(express.json({ limit: "4mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, service: "alf-scout" }));

// SSE: every run event is broadcast here. The dashboard filters on
// `msg.type === "research"` and reads `msg.event`.
app.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  addClient(res);
  const keepAlive = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25_000);
  req.on("close", () => clearInterval(keepAlive));
});

app.use("/api/research", research);

app.listen(PORT, HOST, () => {
  console.log(`alf-scout server on http://${HOST}:${PORT}`);
});
