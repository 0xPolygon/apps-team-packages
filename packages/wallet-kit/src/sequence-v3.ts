/**
 * Sequence v3 has bytecode but EOA-like submission, so team-standard SCW
 * UX and permit gating need to distinguish it from generic SCWs.
 */
export const SEQUENCE_V3_CONNECTOR_ID = 'sequence-v3-wallet';

export const isSequenceV3Connector = (connector: { id: string } | undefined | null): boolean => {
  return connector?.id === SEQUENCE_V3_CONNECTOR_ID;
};

export interface SequenceV3Provider {
  setUseWalletTransactionForSend: (enabled: boolean) => void;
}

export const supportsWalletTransactionForSend = (
  provider: unknown
): provider is SequenceV3Provider => {
  if (provider === null || typeof provider !== 'object') return false;
  if (!('setUseWalletTransactionForSend' in provider)) return false;
  return typeof provider.setUseWalletTransactionForSend === 'function';
};
