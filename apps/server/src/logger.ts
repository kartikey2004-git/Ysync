import { randomUUID } from "node:crypto";
import winston from "winston";

// One centralized logger for the whole app. Not injected like RoomManagerOptions — this is a cross-cutting concern (it used to just be console), not a swappable dependency.

const isProduction = process.env.NODE_ENV === "production";
const defaultLevel = isProduction ? "info" : "debug";

// a random id per process boot — same pattern as RoomManager.processId, but just for logs, not for the pub/sub origin filter
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
  // an escape hatch just for tests — app code never overrides the format, this only exists so tests can check structured fields deterministically
  format?: winston.Logform.Format;
}

// This is a factory, not just a singleton, so tests can plug in their own (in-memory) transport and get an isolated logger instead of having to parse stdout.
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

// The rest of the app imports this, not createLogger — the factory is only for tests that plug in a custom transport.
export const logger = createLogger();

// The structured way to log an error — never pass a bare Error (or anything else) as the log argument, the context silently disappears. Use it like: logger.error("failed to X", { docId, error: errorMeta(err) }).
export function errorMeta(err: unknown): { message: string; name?: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, name: err.name, stack: err.stack };
  }
  return { message: String(err) };
}

// The opId list holds no document content, just ids, but a single batched edit (a big paste, or offline-reconcile catch-up) can carry hundreds of ops — cap it or the log line gets huge. opCount always reports the real total even when the list is truncated.
export function summarizeOpIds(opIds: string[], max = 10): { opCount: number; opIds: string[] } {
  return { opCount: opIds.length, opIds: opIds.length > max ? opIds.slice(0, max) : opIds };
}
