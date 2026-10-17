import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  parseAbi,
  formatUnits
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  QmoosaFactoryArtifact,
  QmoosaRouterArtifact,
  QmoosaPairArtifact,
  MockERC20Artifact
} from "@qmoosa/amm-protocol";
import {
  QmoosaAmmClient,
  AnvilLocalChainAdapter
} from "@qmoosa/amm-sdk";
import { AnvilTestWallet } from "@qmoosa/amm-sdk/testing";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const RPC_URL = "http://127.0.0.1:8545";
const CHAIN_ID = 31337;
const DEV_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DEV_ACCOUNT = privateKeyToAccount(DEV_PRIVATE_KEY);

const anvilChain = defineChain({
  id: CHAIN_ID,
  name: "Anvil Local Sandbox",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } }
});

function findAnvilBinary() {
  const binaryName = process.platform === "win32" ? "anvil.exe" : "anvil";
  // 1. Check ~/.foundry/bin
  const foundryBin = path.join(os.homedir(), ".foundry", "bin", binaryName);
  if (fs.existsSync(foundryBin)) {
    return foundryBin;
  }
  // 2. Default to PATH
  return binaryName;
}

async function isAnvilRunning() {
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(1000)
    });
    if (!res.ok) return false;
    const json = await res.json();
    return json.result === "0x7a69";
  } catch {
    return false;
  }
}

async function startEphemeralAnvil() {
  const anvilBin = findAnvilBinary();
  console.log(`Starting ephemeral Anvil process using: ${anvilBin}...`);
  const child = spawn(anvilBin, ["--chain-id", "31337", "--port", "8545", "--host", "127.0.0.1"], {
    stdio: "pipe",
    detached: false
  });

  child.on("error", (err) => {
    console.error(`Failed to spawn Anvil: ${err.message}`);
  });

  // Wait for Anvil to be healthy
  const startTime = Date.now();
  while (Date.now() - startTime < 15000) {
    if (await isAnvilRunning()) {
      console.log(`[PASS] Anvil RPC active on 127.0.0.1:8545 (Chain ID: 31337)`);
      return child;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Timed out waiting for ephemeral Anvil process to become ready");
}

async function main() {
  console.log("================================================================");
  console.log("=== QMOOSA MISSION 07: LOCAL ANVIL PIPELINE & SETTLEMENT GATE ==");
  console.log("================================================================\n");

  let anvilProcess = null;
  const wasAlreadyRunning = await isAnvilRunning();
  if (!wasAlreadyRunning) {
    anvilProcess = await startEphemeralAnvil();
  } else {
    console.log("[INFO] Using existing active Anvil instance on 127.0.0.1:8545");
  }

  const manifest = {
    mission: "QMOOSA-AMM-07",
    timestamp: new Date().toISOString(),
    network: {
      chainId: CHAIN_ID,
      rpcUrl: RPC_URL,
      isLoopback: true
    },
    contracts: {},
    deployments: {},
    pipelineSteps: [],
    adversarialTests: []
  };

  try {
    const publicClient = createPublicClient({
      chain: anvilChain,
      transport: http(RPC_URL)
    });

    const walletClient = createWalletClient({
      account: DEV_ACCOUNT,
      chain: anvilChain,
      transport: http(RPC_URL)
    });

    // -------------------------------------------------------------
    // Step 1: Active Network & Loopback Verification
    // -------------------------------------------------------------
    console.log("--- [STEP 1: NETWORK & LOOPBACK VERIFICATION] ---");
    const activeChainId = await publicClient.getChainId();
    if (activeChainId !== CHAIN_ID) {
      throw new Error(`Chain ID mismatch! Got ${activeChainId}, expected ${CHAIN_ID}`);
    }
    console.log(`  [PASS] Verified active chainId: ${activeChainId} (Anvil)`);
    console.log(`  [PASS] Endpoint verified strictly bound to loopback: ${RPC_URL}`);
    manifest.pipelineSteps.push({ step: "NETWORK_VERIFICATION", status: "PASS", chainId: activeChainId });

    // -------------------------------------------------------------
    // Step 2: Deploy Genuine Contracts to Local Anvil
    // -------------------------------------------------------------
    console.log("\n--- [STEP 2: DEPLOYING CONTRACTS TO LOCAL ANVIL] ---");

    const ensure0x = (hex) => hex.startsWith("0x") ? hex : `0x${hex}`;

    // 2.1 Factory
    console.log("  Deploying QmoosaFactory...");
    const factoryTxHash = await walletClient.deployContract({
      abi: QmoosaFactoryArtifact.abi,
      bytecode: ensure0x(QmoosaFactoryArtifact.bytecode),
      args: [DEV_ACCOUNT.address]
    });
    const factoryReceipt = await publicClient.waitForTransactionReceipt({ hash: factoryTxHash });
    const factoryAddress = factoryReceipt.contractAddress;
    console.log(`  [PASS] QmoosaFactory deployed at: ${factoryAddress} (tx: ${factoryTxHash.substring(0, 18)}...)`);

    // 2.2 Token A (USDC, 6 decimals)
    console.log("  Deploying MockERC20 (USDC, 6 decimals)...");
    const tokenATxHash = await walletClient.deployContract({
      abi: MockERC20Artifact.abi,
      bytecode: ensure0x(MockERC20Artifact.bytecode),
      args: ["USD Coin", "USDC", 6]
    });
    const tokenAReceipt = await publicClient.waitForTransactionReceipt({ hash: tokenATxHash });
    const tokenAAddress = tokenAReceipt.contractAddress;
    console.log(`  [PASS] USDC Token deployed at: ${tokenAAddress}`);

    // 2.3 Token B (ETH, 18 decimals)
    console.log("  Deploying MockERC20 (ETH, 18 decimals)...");
    const tokenBTxHash = await walletClient.deployContract({
      abi: MockERC20Artifact.abi,
      bytecode: ensure0x(MockERC20Artifact.bytecode),
      args: ["Ether", "ETH", 18]
    });
    const tokenBReceipt = await publicClient.waitForTransactionReceipt({ hash: tokenBTxHash });
    const tokenBAddress = tokenBReceipt.contractAddress;
    console.log(`  [PASS] ETH Token deployed at: ${tokenBAddress}`);

    // 2.4 Router
    console.log("  Deploying QmoosaRouter...");
    const routerTxHash = await walletClient.deployContract({
      abi: QmoosaRouterArtifact.abi,
      bytecode: ensure0x(QmoosaRouterArtifact.bytecode),
      args: [factoryAddress]
    });
    const routerReceipt = await publicClient.waitForTransactionReceipt({ hash: routerTxHash });
    const routerAddress = routerReceipt.contractAddress;
    console.log(`  [PASS] QmoosaRouter deployed at: ${routerAddress}`);

    // 2.5 Bytecode verification
    const deployedAddresses = [
      { name: "Factory", address: factoryAddress },
      { name: "USDC", address: tokenAAddress },
      { name: "ETH", address: tokenBAddress },
      { name: "Router", address: routerAddress }
    ];
    for (const d of deployedAddresses) {
      const code = await publicClient.getCode({ address: d.address });
      if (!code || code === "0x" || code.length < 10) {
        throw new Error(`Bytecode missing for contract ${d.name} at ${d.address}`);
      }
      manifest.contracts[d.name] = { address: d.address, codeLength: code.length };
    }
    console.log(`  [PASS] Deployed contract bytecodes verified on local Anvil state`);

    // -------------------------------------------------------------
    // Step 3: Create Pair & Add Initial Liquidity via Router
    // -------------------------------------------------------------
    console.log("\n--- [STEP 3: POOL CREATION & INITIAL LIQUIDITY ADDITION] ---");

    // Create Pair
    const createPairTx = await walletClient.writeContract({
      address: factoryAddress,
      abi: QmoosaFactoryArtifact.abi,
      functionName: "createPair",
      args: [tokenAAddress, tokenBAddress]
    });
    await publicClient.waitForTransactionReceipt({ hash: createPairTx });

    const pairAddress = await publicClient.readContract({
      address: factoryAddress,
      abi: QmoosaFactoryArtifact.abi,
      functionName: "getPair",
      args: [tokenAAddress, tokenBAddress]
    });
    console.log(`  [PASS] Pair contract created at: ${pairAddress}`);
    manifest.contracts.Pair = { address: pairAddress };

    // Mint tokens to user
    const mintAmountA = 1_000_000n * 10n ** 6n; // 1,000,000 USDC
    const mintAmountB = 1_000n * 10n ** 18n;   // 1,000 ETH
    await walletClient.writeContract({
      address: tokenAAddress,
      abi: MockERC20Artifact.abi,
      functionName: "mint",
      args: [DEV_ACCOUNT.address, mintAmountA]
    });
    await walletClient.writeContract({
      address: tokenBAddress,
      abi: MockERC20Artifact.abi,
      functionName: "mint",
      args: [DEV_ACCOUNT.address, mintAmountB]
    });

    // Approve Router
    await walletClient.writeContract({
      address: tokenAAddress,
      abi: MockERC20Artifact.abi,
      functionName: "approve",
      args: [routerAddress, 2n ** 256n - 1n]
    });
    await walletClient.writeContract({
      address: tokenBAddress,
      abi: MockERC20Artifact.abi,
      functionName: "approve",
      args: [routerAddress, 2n ** 256n - 1n]
    });

    // Add Liquidity: 50,000 USDC & 25 ETH
    const initialLiqA = 50_000n * 10n ** 6n;
    const initialLiqB = 25n * 10n ** 18n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);

    const addLiqTx = await walletClient.writeContract({
      address: routerAddress,
      abi: QmoosaRouterArtifact.abi,
      functionName: "addLiquidity",
      args: [
        tokenAAddress,
        tokenBAddress,
        initialLiqA,
        initialLiqB,
        initialLiqA,
        initialLiqB,
        DEV_ACCOUNT.address,
        deadline
      ]
    });
    const addLiqReceipt = await publicClient.waitForTransactionReceipt({ hash: addLiqTx });
    console.log(`  [PASS] Initial liquidity added (tx: ${addLiqTx.substring(0, 18)}..., gasUsed: ${addLiqReceipt.gasUsed})`);

    // Verify reserves on-chain
    const [reserve0, reserve1] = await publicClient.readContract({
      address: pairAddress,
      abi: QmoosaPairArtifact.abi,
      functionName: "getReserves"
    });
    console.log(`  [PASS] Initial Pair Reserves: reserve0 = ${reserve0}, reserve1 = ${reserve1}`);
    manifest.deployments.initialLiquidity = {
      txHash: addLiqTx,
      gasUsed: addLiqReceipt.gasUsed.toString(),
      reserve0: reserve0.toString(),
      reserve1: reserve1.toString()
    };

    // -------------------------------------------------------------
    // Step 4: Genuine SDK Swapping via AnvilLocalChainAdapter
    // -------------------------------------------------------------
    console.log("\n--- [STEP 4: REAL SDK TRANSACTION PREPARATION, SIGNING & SETTLEMENT] ---");

    const adapter = new AnvilLocalChainAdapter({ rpcUrl: RPC_URL, chainId: CHAIN_ID });
    const wallet = new AnvilTestWallet(DEV_PRIVATE_KEY);
    const client = new QmoosaAmmClient({ chainAdapter: adapter }, wallet);

    // Initial Balances
    const userBalABefore = await publicClient.readContract({
      address: tokenAAddress,
      abi: MockERC20Artifact.abi,
      functionName: "balanceOf",
      args: [DEV_ACCOUNT.address]
    });
    const userBalBBefore = await publicClient.readContract({
      address: tokenBAddress,
      abi: MockERC20Artifact.abi,
      functionName: "balanceOf",
      args: [DEV_ACCOUNT.address]
    });

    console.log(`  User TokenA (USDC) before: ${formatUnits(userBalABefore, 6)} USDC`);
    console.log(`  User TokenB (ETH)  before: ${formatUnits(userBalBBefore, 18)} ETH`);

    // Swap parameters: 1,000 USDC -> ETH
    const swapAmountIn = 1_000n * 10n ** 6n;
    const amountsOut = await publicClient.readContract({
      address: routerAddress,
      abi: QmoosaRouterArtifact.abi,
      functionName: "getAmountsOut",
      args: [swapAmountIn, [tokenAAddress, tokenBAddress]]
    });
    const expectedOut = amountsOut[1];
    const minAmountOut = (expectedOut * 995n) / 1000n; // 0.5% max slippage

    console.log(`  Expected Output from on-chain router: ${formatUnits(expectedOut, 18)} ETH`);
    console.log(`  Minimum acceptable output (0.5% slip):  ${formatUnits(minAmountOut, 18)} ETH`);

    // Execute through SDK
    const swapReceipt = await client.signAndSendSwap({
      routerAddress,
      tokenIn: tokenAAddress,
      tokenOut: tokenBAddress,
      amountIn: swapAmountIn.toString(),
      minAmountOut: minAmountOut.toString(),
      deadlineMinutes: 10
    });

    console.log(`  [PASS] SDK Swap executed on local Anvil:`);
    console.log(`         Transaction Hash: ${swapReceipt.txHash}`);
    console.log(`         Block Number:     ${swapReceipt.blockNumber}`);
    console.log(`         Status:           ${swapReceipt.status}`);
    console.log(`         Gas Used:         ${swapReceipt.gasUsed}`);

    if (swapReceipt.status !== "CONFIRMED") {
      throw new Error(`Swap transaction was not confirmed on local Anvil! Status: ${swapReceipt.status}`);
    }

    // Verify post-swap balances
    const userBalAAfter = await publicClient.readContract({
      address: tokenAAddress,
      abi: MockERC20Artifact.abi,
      functionName: "balanceOf",
      args: [DEV_ACCOUNT.address]
    });
    const userBalBAfter = await publicClient.readContract({
      address: tokenBAddress,
      abi: MockERC20Artifact.abi,
      functionName: "balanceOf",
      args: [DEV_ACCOUNT.address]
    });

    console.log(`  User TokenA (USDC) after:  ${formatUnits(userBalAAfter, 6)} USDC (-${formatUnits(userBalABefore - userBalAAfter, 6)})`);
    console.log(`  User TokenB (ETH)  after:  ${formatUnits(userBalBAfter, 18)} ETH (+${formatUnits(userBalBAfter - userBalBBefore, 18)})`);

    if (userBalABefore - userBalAAfter !== swapAmountIn) {
      throw new Error("TokenIn was not decremented by exact swap amount!");
    }
    if (userBalBAfter - userBalBBefore !== expectedOut) {
      throw new Error("TokenOut was not incremented by exact expected output!");
    }
    console.log(`  [PASS] On-chain balances altered with exact mathematical precision!`);

    // Verify post-swap reserves
    const [res0After, res1After] = await publicClient.readContract({
      address: pairAddress,
      abi: QmoosaPairArtifact.abi,
      functionName: "getReserves"
    });
    console.log(`  Post-Swap Pair Reserves: reserve0 = ${res0After}, reserve1 = ${res1After}`);

    manifest.deployments.swap = {
      txHash: swapReceipt.txHash,
      blockNumber: swapReceipt.blockNumber,
      gasUsed: swapReceipt.gasUsed,
      userBalancesBefore: { tokenA: userBalABefore.toString(), tokenB: userBalBBefore.toString() },
      userBalancesAfter: { tokenA: userBalAAfter.toString(), tokenB: userBalBAfter.toString() },
      pairReservesBefore: { reserve0: reserve0.toString(), reserve1: reserve1.toString() },
      pairReservesAfter: { reserve0: res0After.toString(), reserve1: res1After.toString() }
    };

    // -------------------------------------------------------------
    // Step 5: Adversarial / Negative Attack Verification on Anvil
    // -------------------------------------------------------------
    console.log("\n--- [STEP 5: ADVERSARIAL & FAIL-CLOSED NEGATIVE TESTS] ---");

    // Attack 1: Excessive Slippage Rejection
    console.log("  Testing Attack 1: High slippage attempt (unreasonable minAmountOut)...");
    const excessiveMinOut = expectedOut * 2n; // Demanding 200% of reserves
    const badSlippageReceipt = await client.signAndSendSwap({
      routerAddress,
      tokenIn: tokenAAddress,
      tokenOut: tokenBAddress,
      amountIn: swapAmountIn.toString(),
      minAmountOut: excessiveMinOut.toString(),
      deadlineMinutes: 10
    });
    if (badSlippageReceipt.status !== "FAILED") {
      throw new Error("Adversarial high slippage swap should have reverted on-chain!");
    }
    console.log(`  [PASS] High slippage transaction strictly reverted on Anvil (status: FAILED)`);
    manifest.adversarialTests.push({ test: "SLIPPAGE_PROTECTION", status: "PASS", result: "FAILED_STATUS_REVERT" });

    // Attack 2: Expired Deadline Rejection
    console.log("  Testing Attack 2: Expired deadline transaction...");
    const expiredReceipt = await client.signAndSendSwap({
      routerAddress,
      tokenIn: tokenAAddress,
      tokenOut: tokenBAddress,
      amountIn: swapAmountIn.toString(),
      minAmountOut: "0",
      deadlineMinutes: -10 // in the past
    });
    if (expiredReceipt.status !== "FAILED") {
      throw new Error("Expired deadline swap should have reverted on-chain!");
    }
    console.log(`  [PASS] Expired deadline transaction strictly reverted on Anvil (status: FAILED)`);
    manifest.adversarialTests.push({ test: "DEADLINE_PROTECTION", status: "PASS", result: "FAILED_STATUS_REVERT" });

    // Attack 3: Non-Loopback Network Rejection
    console.log("  Testing Attack 3: Non-loopback endpoint rejection...");
    try {
      new AnvilLocalChainAdapter({ rpcUrl: "https://mainnet.infura.io/v3/compromised-key" });
      throw new Error("Should have rejected non-loopback endpoint!");
    } catch (err) {
      if (!err.message.includes("NON_LOOPBACK_RPC_FORBIDDEN")) throw err;
      console.log(`  [PASS] Non-loopback RPC URL strictly rejected: NON_LOOPBACK_RPC_FORBIDDEN`);
      manifest.adversarialTests.push({ test: "NON_LOOPBACK_PROTECTION", status: "PASS", result: "REJECTED" });
    }

    // Save Evidence Manifest
    const manifestPath = path.join(rootDir, "anvil-evidence-manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`\n================================================================`);
    console.log(`[PASS] Mission 07 Anvil Evidence Manifest written to:`);
    console.log(`       ${manifestPath}`);
    console.log(`================================================================\n`);

  } finally {
    if (anvilProcess) {
      console.log("Stopping ephemeral local Anvil process...");
      anvilProcess.kill("SIGTERM");
    }
  }
}

main().catch((err) => {
  console.error(`\n[FATAL ERROR] Anvil Verification Failed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
