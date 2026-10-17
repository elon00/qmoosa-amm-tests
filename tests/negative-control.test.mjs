import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  AmmEngine,
  InsufficientLiquidityError,
  ExcessiveSlippageError,
  DeadlineExpiredError
} from "@qmoosa/amm-engine";

import {
  QmoosaAmmClient,
  WalletNotConnectedError,
  UnsupportedChainAdapterError,
  InvalidQuoteError
} from "@qmoosa/amm-sdk";

import { MockWalletAdapter } from "@qmoosa/amm-sdk/testing";

describe("Negative Control & Tamper-Rejection Test Suite (Mission 05C)", () => {
  const creator = "0xCreatorAccount999";
  const trader = "0xTraderAccount888";

  test("Negative Control 1: Identical token identifiers strictly fail pool creation", () => {
    const engine = new AmmEngine();
    assert.throws(
      () => engine.createPool("USDC", "USDC", 1000n, 1000n, creator, 30),
      /AMM_IDENTICAL_ADDRESSES/
    );
    assert.throws(
      () => engine.createPool("eth", "ETH", 1000n, 1000n, creator, 30),
      /AMM_IDENTICAL_ADDRESSES/
    );
  });

  test("Negative Control 2: Zero or negative liquidity amounts strictly fail", () => {
    const engine = new AmmEngine();
    assert.throws(
      () => engine.createPool("USDC", "ETH", 0n, 1000n, creator, 30),
      /AMM_ZERO_AMOUNT/
    );
    assert.throws(
      () => engine.createPool("USDC", "ETH", -100n, 1000n, creator, 30),
      /AMM_ZERO_AMOUNT/
    );
  });

  test("Negative Control 3: Intentionally invalid fee basis points fail", () => {
    const engine = new AmmEngine();
    assert.throws(
      () => engine.createPool("USDC", "ETH", 1000n, 1000n, creator, 0),
      /AMM_INVALID_FEE_BPS/
    );
    assert.throws(
      () => engine.createPool("USDC", "ETH", 1000n, 1000n, creator, 1001),
      /AMM_INVALID_FEE_BPS/
    );
  });

  test("Negative Control 4: Expired deadline transaction is strictly reverted", () => {
    const engine = new AmmEngine();
    const { poolId } = engine.createPool("USDC", "ETH", 1000000n, 1000n, creator, 30);
    const expiredTimestamp = Date.now() - 10000;

    assert.throws(
      () => engine.swap(poolId, "USDC", 1000n, 1n, trader, expiredTimestamp),
      (err) => err instanceof DeadlineExpiredError
    );
  });

  test("Negative Control 5: Intentionally corrupted quote amounts fail SDK validation", async () => {
    const client = new QmoosaAmmClient();
    await assert.rejects(
      () => client.getQuote({ tokenIn: "USDC", tokenOut: "ETH", amountIn: "1e3" }, "10000", "20000"),
      (err) => err instanceof InvalidQuoteError
    );
    await assert.rejects(
      () => client.getQuote({ tokenIn: "USDC", tokenOut: "ETH", amountIn: "-100" }, "10000", "20000"),
      (err) => err instanceof InvalidQuoteError
    );
  });

  test("Negative Control 6: Unconfigured broadcast adapter strictly fails closed (Zero manufactured hashes)", async () => {
    const client = new QmoosaAmmClient();
    client.setWallet(new MockWalletAdapter());

    await assert.rejects(
      () => client.signAndSendSwap({
        tokenIn: "USDC",
        tokenOut: "ETH",
        amountIn: "1000",
        minAmountOut: "990"
      }),
      (err) => err instanceof UnsupportedChainAdapterError
    );
  });
});
