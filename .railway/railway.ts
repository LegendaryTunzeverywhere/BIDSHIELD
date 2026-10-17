import { defineRailway, github, project, service, volume } from "railway/iac";

// Full Bidshield regtest stack for Railway. Service names double as private
// DNS names, and they must match the hostnames baked into the containers:
// zecd connects to zebra://zebra:18234, the api waits on
// http://auctioneer:9233/readyz + http://funder:9243/readyz, and the bootstrap
// job waits on http://api:8080/api/health. See docs/RAILWAY.md.
export default defineRailway(() => {
  const src = () =>
    github("cosmopolitanguru002/BIDSHIELD", { branch: "main", checkSuites: false });

  const zebra = service("zebra", {
    source: src(),
    build: {
      buildEnvironment: "V3",
      builder: "DOCKERFILE",
      dockerfilePath: "docker/railway/zebra.Dockerfile",
    },
    replicas: { iad: 1 },
    networking: { privateNetworkEndpoint: "zebra" },
    volumeMounts: { "zebra-cache": { mountPath: "/var/cache/zebra" } },
    deploy: { restartPolicyType: "ALWAYS" },
  });

  // The hosted in-app wallet: restores the canonical all-zero BIP-39 test
  // vector (public test material, also in e2e/spike.mjs). Its datadir lives on
  // a volume so wallet state survives redeploys.
  const funder = service("funder", {
    source: src(),
    build: {
      buildEnvironment: "V3",
      builder: "DOCKERFILE",
      dockerfilePath: "docker/railway/zecd.Dockerfile",
    },
    replicas: { iad: 1 },
    networking: { privateNetworkEndpoint: "funder" },
    variables: {
      ZECD_ROLE: { value: "funder" },
      ZECD_MNEMONIC: {
        value:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
      },
    },
    volumeMounts: { "funder-data": { mountPath: "/var/lib/zecd" } },
    deploy: { restartPolicyType: "ALWAYS" },
  });

  // Escrow wallet: seed deliberately NOT in this file (this repo is pushed to
  // GitHub). Set it once on this service — Railway dashboard → auctioneer →
  // Variables → ZECD_MNEMONIC, or:
  //   railway variable set ZECD_MNEMONIC="<phrase>" --service auctioneer
  // Keep the same value as ZECD_MNEMONIC in the repo's gitignored .env (used
  // by e2e/spike.mjs locally). Phrase: the public BIP-39 "legal winner" test
  // vector (regtest material). On a fresh volume the entrypoint restores it
  // (and refuses to create a random wallet if the variable is missing); the
  // auctioneer UA is additionally persisted in the api database per network
  // and reused across redeploys (validated with z_validateaddress).
  const auctioneer = service("auctioneer", {
    source: src(),
    build: {
      buildEnvironment: "V3",
      builder: "DOCKERFILE",
      dockerfilePath: "docker/railway/zecd.Dockerfile",
    },
    replicas: { iad: 1 },
    networking: { privateNetworkEndpoint: "auctioneer" },
    variables: {
      ZECD_ROLE: { value: "auctioneer" },
    },
    volumeMounts: { "auctioneer-data": { mountPath: "/var/lib/zecd" } },
    deploy: { restartPolicyType: "ALWAYS" },
  });

  // Bring-up + refill job: mines the regtest chain to the funder's miner
  // address, shields mature coinbase, waits for the api, then keeps the
  // faucet reserve topped up forever (re-mines + re-shields whenever the
  // funder's shielded balance drops under FUNDER_TARGET_ZATS). Exits nonzero
  // on bring-up failure; Railway restarts it = retry.
  const bootstrap = service("bootstrap", {
    source: src(),
    build: {
      buildEnvironment: "V3",
      builder: "DOCKERFILE",
      dockerfilePath: "docker/railway/bootstrap.Dockerfile",
    },
    replicas: { iad: 1 },
    variables: {
      // Keep ≥ 100 ZEC of shielded reserve (200 faucet claims of 0.5 ZEC).
      FUNDER_TARGET_ZATS: { value: "10000000000" },
      // Blocks per top-up round; the first (TOPUP_BLOCKS-100) mature.
      TOPUP_BLOCKS: { value: "120" },
    },
    deploy: { restartPolicyType: "ALWAYS" },
  });

  // Existing public service. Private DNS alias "api" matches the hostname the
  // bootstrap job waits on; the public domain keeps serving port 8080.
  const api = service("BIDSHIELD", {
    source: src(),
    build: {
      buildEnvironment: "V3",
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
    },
    replicas: { iad: 1 },
    networking: {
      privateNetworkEndpoint: "api",
      serviceDomains: { bidshield: { port: 8080 } },
    },
    variables: {
      RUST_LOG: { value: "info" },
      ZECD_URL: { value: "http://auctioneer:18232/" },
      ZECD_HEALTH: { value: "http://auctioneer:9233/readyz" },
      ZEBRA_URL: { value: "http://zebra:18234" },
      ZECD_USER: { value: "auctioneer" },
      ZECD_PASS: { value: "regtest-auctioneer-pw" },
      FUNDER_URL: { value: "http://funder:18242/" },
      FUNDER_HEALTH: { value: "http://funder:9243/readyz" },
      FUNDER_USER: { value: "funder" },
      FUNDER_PASS: { value: "regtest-funder-pw" },
      FAUCET_ZATS: { value: "50000000" },
      FAUCET_COOLDOWN_SECS: { value: "60" },
      MINER_INTERVAL_SECS: { value: "1" },
      DB_PATH: { value: "/data/bidshield.db" },
      COOKIE_SECURE: { value: "1" },
      // Split frontend: the api must accept the Vercel origin — proxied
      // /api/* requests still carry Origin: <vercel> vs Host: <railway>, and
      // the server-side origin check 401s without this. Keep it here (not the
      // dashboard): this file's variables win on every apply.
      CORS_ORIGIN: { value: "https://bidshield-demo.vercel.app" },
      SYNC_PROGRESS_MIN: { value: "0.9999" },
    },
    volumeMounts: { "api-data": { mountPath: "/data" } },
    deploy: {
      healthcheckPath: "/api/health",
      healthcheckTimeout: 300,
      restartPolicyType: "ALWAYS",
    },
  });

  const apiData = volume("api-data", { sizeMB: 500 });
  const zebraCache = volume("zebra-cache", { sizeMB: 500 });
  const funderData = volume("funder-data", { sizeMB: 500 });
  const auctioneerData = volume("auctioneer-data", { sizeMB: 500 });

  return project("ingenious-dream", {
    resources: [
      zebra,
      funder,
      auctioneer,
      bootstrap,
      api,
      apiData,
      zebraCache,
      funderData,
      auctioneerData,
    ],
  });
});
