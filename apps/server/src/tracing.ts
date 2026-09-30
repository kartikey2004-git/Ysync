import { trace } from "@opentelemetry/api";

let sdkStarted = false;

export function initTracing(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const exporter = process.env.OTEL_TRACES_EXPORTER;

  if (!endpoint && exporter !== "console") {
    return;
  }

  import("@opentelemetry/sdk-node").then(async ({ NodeSDK }) => {
    const [
      { getNodeAutoInstrumentations },
      { OTLPTraceExporter },
      { Resource },
      { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
    ] = await Promise.all([
      import("@opentelemetry/auto-instrumentations-node"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/resources"),
      import("@opentelemetry/semantic-conventions"),
    ]);

    const sdk = new NodeSDK({
      resource: new Resource({
        [ATTR_SERVICE_NAME]: "ysync-server",
        [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.1.0",
      }),
      traceExporter: new OTLPTraceExporter({ url: endpoint ? `${endpoint}/v1/traces` : undefined }),
      instrumentations: [
        getNodeAutoInstrumentations({
          "@opentelemetry/instrumentation-fs": { enabled: false },
          "@opentelemetry/instrumentation-dns": { enabled: false },
          "@opentelemetry/instrumentation-net": { enabled: false },
        }),
      ],
    });

    sdk.start();
    sdkStarted = true;

    process.on("SIGTERM", () => {
      sdk.shutdown().catch(() => {});
    });
  }).catch(() => {
    // OTEL packages not available — no tracing
  });
}

export function isTracingEnabled(): boolean {
  return sdkStarted;
}

export { trace };
