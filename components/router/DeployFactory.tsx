'use client';

/**
 * Deploys the LockFi Router factory from the owner's own wallet (§48). The
 * wallet that deploys it is its owner: it can name the keeper and the
 * treasury, and nothing else. The fee is fixed here, at deployment, and the
 * contract refuses anything over 2%.
 *
 * No key ever reaches the server for this. The creation bytecode is loaded
 * only on this page, since no other page needs it.
 */

import { useState } from 'react';
import { encodeDeployData, isAddress, type Address, type Hex } from 'viem';
import { useUi } from '@/components/providers/UiProvider';
import { CONTRACTS, EXPLORER_URL, ROUTER_FACTORY, ROUTER_FEE_BPS } from '@/lib/chain';
import { FACTORY_ABI } from '@/lib/router/plan';
import { publicClient, walletClient } from '@/lib/v4/client';
import { describeWalletError, ensureChain } from '@/lib/wallet';

export function DeployFactory() {
  const { wallet, openWallet, showToast } = useUi();
  const [keeper, setKeeper] = useState('');
  const [treasury, setTreasury] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deployed, setDeployed] = useState<Address | null>(null);

  const treasuryAddr = treasury.trim() || wallet?.address || '';
  const ready = isAddress(keeper.trim()) && isAddress(treasuryAddr);

  if (ROUTER_FACTORY) {
    return (
      <div className="card panel">
        <h2 className="sect-h">Factory deployed</h2>
        <p className="hint">
          The router factory is live at{' '}
          <a href={`${EXPLORER_URL}/address/${ROUTER_FACTORY}`} target="_blank" rel="noreferrer">
            <code className="num">{ROUTER_FACTORY}</code>
          </a>
          . There is nothing to do here.
        </p>
      </div>
    );
  }

  const deploy = async () => {
    if (!wallet) {
      openWallet();
      return;
    }
    setError(null);
    setBusy('Loading the contract…');
    try {
      const { bytecode } = (await import('@/lib/router/factory-bytecode.json')).default as { bytecode: Hex };
      await ensureChain(wallet.provider);
      const account = wallet.address as Address;
      const args = [CONTRACTS.poolManager, CONTRACTS.weth, CONTRACTS.v3Factory, ROUTER_FEE_BPS, treasuryAddr, keeper.trim()] as const;
      const client = publicClient();
      setBusy('Checking the deployment…');
      await client.estimateGas({ account, data: encodeDeployData({ abi: FACTORY_ABI, bytecode, args }) });
      setBusy('Confirm in your wallet…');
      const hash = await walletClient(wallet.provider, account).deployContract({ abi: FACTORY_ABI, bytecode, args, account, chain: undefined });
      setBusy('Waiting for the block…');
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('The deployment reverted on chain.');
      setDeployed(receipt.contractAddress);
      showToast('Router factory deployed');
    } catch (e) {
      setError(describeWalletError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card panel" style={{ maxWidth: 720 }}>
      <h2 className="sect-h">Deploy the router factory</h2>
      <p className="hint">
        One transaction, once. The wallet that sends it owns the factory: it can name a new keeper or treasury later, and
        nothing else. It cannot reach any router&apos;s funds or liquidity.
      </p>

      <div className="field" style={{ marginTop: 14 }}>
        <label htmlFor="d-keeper">Keeper address</label>
        <div className="inp" style={{ height: 44 }}>
          <input id="d-keeper" placeholder="0x… the keeper wallet on the server" value={keeper} onChange={(e) => setKeeper(e.target.value)} />
        </div>
        <p className="hint">A fresh wallet whose key goes in KEEPER_PRIVATE_KEY on the server. It only pays gas; it never receives funds.</p>
      </div>

      <div className="field">
        <label htmlFor="d-treasury">Treasury address</label>
        <div className="inp" style={{ height: 44 }}>
          <input id="d-treasury" placeholder={wallet?.address ?? '0x… where the LockFi fee goes'} value={treasury} onChange={(e) => setTreasury(e.target.value)} />
        </div>
        <p className="hint">Where the {ROUTER_FEE_BPS / 100}% LockFi fee is paid. Empty means the wallet deploying.</p>
      </div>

      <div className="field">
        <span className="lbl">Fee</span>
        <p className="num" style={{ fontSize: 15, fontWeight: 600 }}>
          {ROUTER_FEE_BPS / 100}% of the ETH routed, fixed forever (the contract refuses more than 2%)
        </p>
      </div>

      <button className="btn btn-brand" style={{ width: '100%', justifyContent: 'center', height: 46 }} disabled={busy !== null || (wallet !== null && !ready)} onClick={() => void deploy()}>
        {busy ?? (wallet ? 'Deploy the factory' : 'Connect wallet')}
      </button>
      {error && (
        <p className="hint down" role="alert" style={{ marginTop: 8 }}>
          {error}
        </p>
      )}

      {deployed && (
        <div className="note" style={{ marginTop: 14 }} data-testid="factory-deployed">
          <b>Deployed.</b>
          <div className="ca" style={{ marginTop: 8 }}>
            <code className="num">{deployed}</code>
            <div className="ca-actions">
              <button
                type="button"
                className="btn btn-ghost sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(deployed);
                    showToast('Factory address copied');
                  } catch {
                    showToast('Could not copy — select the address instead');
                  }
                }}
              >
                Copy
              </button>
              <a className="btn btn-ghost sm" href={`${EXPLORER_URL}/address/${deployed}`} target="_blank" rel="noreferrer">
                Explorer
              </a>
            </div>
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            Send this address to your developer. It goes in ROUTER_FACTORY in lib/chain.ts, and the next deploy switches the
            router page on.
          </p>
        </div>
      )}
    </div>
  );
}
