import { randomUUID } from "node:crypto";
import winston from "winston";

// Pure app ke liye ek hi centralized logger. RoomManagerOptions ki tarah
// inject nahi karte — yeh cross-cutting concern hai (jaise pehle console tha),
// koi swappable dependency nahi hai.

const isProduction = process.env.NODE_ENV === "production";
const defaultLevel = isProduction ? "info" : "debug";

// har process boot pe ek random id — RoomManager.processId jaisa hi pattern, bas logs ke liye, pub/sub origin-filter ke liye nahi
const instanceId = randomUUID();

const cloudRunMeta: Record<string, string> = {};
if (process.env.K_SERVICE) cloudRunMeta.cloudRunService = process.env.K_SERVICE;
if (process.env.K_REVISION) cloudRunMeta.cloudRunRevision = process.env.K_REVISION;

const baseFormat = winston.format.combine(winston.format.errors({ stack: true }), winston.format.timestamp());

const productionFormat = winston.format.combine(baseFormat, winston.format.json());

const developmentFormat = winston.format.combine(
  baseFormat,
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, service, environment, instanceId, cloudRunService, cloudRunRevision, ...meta }) => {
    const rest = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
    return `${String(timestamp)} ${level}: ${String(message)}${rest}`;
  }),
);

export interface LoggerOverrides {
  level?: string;
  transports?: winston.transport[];
  // sirf tests ke liye escape hatch hai — app code kabhi format override nahi karta,
  // sirf tests ko structured fields deterministically check karne ke liye chahiye
  format?: winston.Logform.Format;
}

// Sirf singleton nahi, factory bhi banaya hai — taaki tests apna custom
// (in-memory) transport laga ke isolated logger bana sakein, stdout parse na karna pade
export function createLogger(overrides: LoggerOverrides = {}): winston.Logger {
  return winston.createLogger({
    level: overrides.level ?? process.env.LOG_LEVEL ?? defaultLevel,
    format: overrides.format ?? (isProduction ? productionFormat : developmentFormat),
    defaultMeta: {
      service: "ysync-server",
      environment: process.env.NODE_ENV ?? "development",
      instanceId,
      ...cloudRunMeta,
    },
    transports: overrides.transports ?? [new winston.transports.Console()],
  });
}

// Baaki poori app yahi import karti hai, createLogger nahi — factory sirf
// tests ke liye hai jo custom transport lagate hain.
export const logger = createLogger();

// Error ko log karne ka structured tareeka — kabhi bhi bare Error (ya kuch bhi)
// log argument mein mat daalo, context chup chaap gayab ho jata hai.
// Use aise karo: logger.error("failed to X", { docId, error: errorMeta(err) }).
export function errorMeta(err: unknown): { message: string; name?: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, name: err.name, stack: err.stack };
  }
  return { message: String(err) };
}

// opId list mein document content nahi hota, sirf ids hoti hain, lekin ek hi
// batched edit (bada paste, ya offline-reconcile catch-up) mein sau-do-sau
// ops aa sakte hain — cap laga do warna log line bahut bada ho jayega.
// opCount hamesha asli total dikhayega, chahe list truncate ho.
export function summarizeOpIds(opIds: string[], max = 10): { opCount: number; opIds: string[] } {
  return { opCount: opIds.length, opIds: opIds.length > max ? opIds.slice(0, max) : opIds };
}
