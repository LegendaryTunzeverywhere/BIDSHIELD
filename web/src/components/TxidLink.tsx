import { explorerTxUrl, shortId } from '../api';

/**
 * A txid as mono text on regtest, or a zecblock link on mainnet/testnet
 * (`zecblock.com/tx/{txid}`, `testnet.zecblock.com/tx/{txid}`).
 */
export default function TxidLink({
  network,
  txid,
  keep,
}: {
  network: string | null;
  txid: string;
  keep?: number;
}) {
  const url = explorerTxUrl(network, txid);
  const label = keep ? shortId(txid, keep) : txid;
  if (!url) {
    return <span className="mono">{label}</span>;
  }
  return (
    <a className="mono" href={url} target="_blank" rel="noreferrer" title={txid}>
      {label}
    </a>
  );
}
