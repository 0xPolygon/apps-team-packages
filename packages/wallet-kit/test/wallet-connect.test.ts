import { describe, expect, it } from 'vitest';

import { nonSwitchingWalletConnect } from '../src/wallet-connect.ts';

describe('nonSwitchingWalletConnect', () => {
  // The modal renders the connector by its descriptor, so the WalletConnect
  // identity (id, name, logos) must survive the swap — only the connector
  // implementation changes.
  it('preserves the WalletConnect descriptor identity', () => {
    const wallet = nonSwitchingWalletConnect({ projectId: 'test-project-id' });

    expect(wallet).property('id', 'wallet-connect');
    expect(wallet).property('name', 'WalletConnect');
    expect(wallet).property('logoDark');
    expect(wallet).property('logoLight');
  });

  it('exposes a createConnector factory', () => {
    const wallet = nonSwitchingWalletConnect({ projectId: 'test-project-id' });

    expect(wallet.createConnector).a('function');
  });
});
