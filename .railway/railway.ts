import { defineRailway, project, service, volume } from "railway/iac";

// Weft's API on Railway (replaces railway.json, which stops working on 2026-12-01).
// Variables (all secrets) stay unmanaged: they live only on Railway, never in this file.
export default defineRailway(() => {
  // The SQLite databases and hourly backups live here. Never drop it from this file: a plan
  // without it detaches the volume.
  const weftApiVolume = volume("weft-api-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "europe-west4-drams3a", sizeMB: 50000 });
  const weftApi = service("weft-api", {
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    deploy: { healthcheckPath: "/health", healthcheckTimeout: 60, restartPolicyMaxRetries: 5 },
    replicas: { "europe-west4-drams3a": 1 },
    volumeMounts: { "/data": weftApiVolume },
  });

  return project("weft", {
    variables: { managed: false },
    resources: [weftApi, weftApiVolume],
  });
});
