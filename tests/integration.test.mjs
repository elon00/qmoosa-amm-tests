import { test, describe } from "node:test";
import assert from "node:assert/strict";

// REAL IMPORTS FROM SIBLING PACKAGES (No copied formulas!)
import {
  verifyConstantProductInvariant,
  canonicalizeTokenPair,
  validateFeeBps
} from "@qmoosa/amm-protocol";

import {
  AmmEngine,
  InsufficientLiquidityError,
  ExcessiveSlippageError,
  DeadlineExpiredError
} from "@qmoosa/amm-engine";

import {
  QmoosaAmmClient,
  WalletNotConnectedError,
  UnsupportedChainAdapterError
} from "@qmoosa/amm-sdk";
import { MockWalletAdapter } from "@qmoosa/amm-sdk/testing";


describe("Cross-Repository Integration & Reality Test Suite", () => {
  const creator = "0xCreatorAccount111";
  const trader = "0xTraderAccount222";
  const deadline = Date.now() + 120000;

  test("1. Real Protocol & Real Engine Initialization", () => {
    // Protocol-level validations
    assert.doesNotThrow(() => validateFeeBps(30));
    const [t0Evm, t1Evm] = canonicalizeTokenPair("USDC", "ETH"); // Default EVM case-folded
    assert.equal(t0Evm, "eth");
    assert.equal(t1Evm, "usdc");

    const [t0, t1] = canonicalizeTokenPair("USDC", "ETH", "CASE_SENSITIVE_CANONICAL");
    assert.equal(t0, "ETH");
    assert.equal(t1, "USDC");

    // Real engine instantiation & pool creation
    const engine = new AmmEngine();
    const { poolId, lpTokensMinted } = engine.createPool("USDC", "ETH", 100000000n, 50000n, creator, 30);
    assert.ok(poolId);
    assert.equal(lpTokensMinted > 0n, true);

    const pool = engine.store.getPool(poolId);
    assert.equal(pool.tokenA, "ETH");
    assert.equal(pool.tokenB, "USDC");
    assert.equal(pool.reserveA, "50000");
    assert.equal(pool.reserveB, "100000000");
  });

  test("2. Real Cross-Component Quote Alignment (SDK <-> Engine)", async () => {
    const engine = new AmmEngine();
    const { poolId } = engine.createPool("USDC", "ETH", 100000000n, 50000n, creator, 30);
    const pool = engine.store.getPool(poolId);

    // SDK computes quote using real protocol logic
    const client = new QmoosaAmmClient({ defaultSlippageBps: 50 });
    const amountIn = "1000000"; // 1M USDC for ETH
    const quote = await client.getQuote(
      { tokenIn: "USDC", tokenOut: "ETH", amountIn },
      pool.reserveB, // reserveIn is USDC (reserveB)
      pool.reserveA  // reserveOut is ETH (reserveA)
    );

    // Engine executes trade with exact quote inputs
    const { amountOut, feeAmount } = engine.swap(
      poolId,
      "USDC",
      BigInt(amountIn),
      BigInt(quote.minAmountOut),
      trader,
      deadline
    );

    // Exact parity between SDK expected quote and real engine outcome
    assert.equal(amountOut.toString(), quote.expectedAmountOut);
    assert.equal(feeAmount.toString(), quote.feeAmount);
    assert.equal(amountOut >= BigInt(quote.minAmountOut), true);
  });

  test("3. Real Slippage & Deadline Enforcement with Atomic State Preservation", () => {
    const engine = new AmmEngine();
    const { poolId } = engine.createPool("USDC", "ETH", 100000000n, 50000n, creator, 30);
    const poolBefore = engine.store.getPool(poolId);

    // Past deadline throws DeadlineExpiredError
    assert.throws(
      () => engine.swap(poolId, "USDC", 1000000n, 1n, trader, Date.now() - 1000),
      (err) => err instanceof DeadlineExpiredError
    );

    // Unrealistic slippage constraint throws ExcessiveSlippageError
    assert.throws(
      () => engine.swap(poolId, "USDC", 1000000n, 999999999n, trader, deadline),
      (err) => err instanceof ExcessiveSlippageError
    );

    // Verify engine state is preserved atomically (zero corruption on revert)
    const poolAfter = engine.store.getPool(poolId);
    assert.equal(poolBefore.reserveA, poolAfter.reserveA);
    assert.equal(poolBefore.reserveB, poolAfter.reserveB);
    assert.equal(poolBefore.tradeCount, poolAfter.tradeCount);
  });

  test("4. Real Optimal Deposit Ratios and Excess Liquidity Refund", () => {
    const engine = new AmmEngine();
    // Pool initialized with 1:2 ratio (10,000 ETH : 20,000 USDC)
    const { poolId } = engine.createPool("ETH", "USDC", 10000n, 20000n, creator, 30);

    // Provider offers 1,000 ETH and 3,000 USDC (1,000 excess USDC provided)
    const { amountA, amountB, refundA, refundB, lpTokensMinted } = engine.addLiquidity(
      poolId, 1000n, 3000n, 1000n, 2000n, trader, deadline
    );

    assert.equal(amountA, 1000n);
    assert.equal(amountB, 2000n);
    assert.equal(refundA, 0n);
    assert.equal(refundB, 1000n, "Engine must refund excess deposit to protect LP");
    assert.ok(lpTokensMinted > 0n);
  });

  test("5. Real Liquidity Removal and Locked Minimum Liquidity Protection", () => {
    const engine = new AmmEngine();
    const { poolId, lpTokensMinted } = engine.createPool("ETH", "USDC", 50000n, 100000n, creator, 30);

    // Redeem 40% of creator's LP tokens
    const lpToBurn = (lpTokensMinted * 40n) / 100n;
    const { amountA, amountB } = engine.removeLiquidity(
      poolId, lpToBurn, 0n, 0n, creator, deadline
    );

    assert.ok(amountA > 0n);
    assert.ok(amountB > 0n);

    // Attempting to burn more than user's LP balance or total available fails closed
    const pool = engine.store.getPool(poolId);
    const totalLp = BigInt(pool.totalLpSupply);
    assert.throws(
      () => engine.removeLiquidity(poolId, totalLp, 0n, 0n, creator, deadline),
      /AMM_INSUFFICIENT_LP_BALANCE|AMM_INSUFFICIENT_LIQUIDITY/
    );
  });

  test("6. Real Adversarial Sandwich Defense via Strict Slippage Barrier", () => {
    const engine = new AmmEngine();
    const { poolId } = engine.createPool("USDC", "ETH", 10000000n, 5000n, creator, 30);

    // Honest trader calculates quote with 0.5% max slippage
    const honestIn = 50000n;
    const expectedOut = 24n; // Approx
    const minAcceptableOut = 24n;

    // Attacker executes large front-run trade, skewing the pool price
    engine.swap(poolId, "USDC", 5000000n, 1n, "0xAttacker", deadline);

    // Honest trader execution now attempts to run on manipulated pool:
    // Slippage barrier MUST fail-closed and throw ExcessiveSlippageError!
    assert.throws(
      () => engine.swap(poolId, "USDC", honestIn, minAcceptableOut, trader, deadline),
      (err) => err instanceof ExcessiveSlippageError
    );
  });

  test("7. Real SDK Fail-Closed Production Barriers", async () => {
    const client = new QmoosaAmmClient();

    // 1. Cannot build payload without wallet
    await assert.rejects(
      () => client.buildSwapPayload({ tokenIn: "USDC", tokenOut: "ETH", amountIn: "100", minAmountOut: "99" }),
      (err) => err instanceof WalletNotConnectedError
    );

    // 2. Cannot broadcast without active ChainTransactionAdapter (Zero fake hashes!)
    client.setWallet(new MockWalletAdapter());
    await assert.rejects(
      () => client.signAndSendSwap({ tokenIn: "USDC", tokenOut: "ETH", amountIn: "100", minAmountOut: "99" }),
      (err) => err instanceof UnsupportedChainAdapterError
    );
  });
});
