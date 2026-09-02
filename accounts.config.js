export const accountConfiguration = Object.freeze({
  version: 1,
  accountPairs: Object.freeze([
    'kumarneo.txt|neokumar.txt',
  ]),
  cardSources: Object.freeze({
    funds: 'read',
    positions: 'read',
    holdings: 'read',
    orderLog: 'read',
    signalContract: 'trade',
    signalLtp: 'trade',
    orderPlacement: 'trade',
  }),
  refreshMs: Object.freeze({
    positions: 2000,
    accountDetails: 30000,
  }),
});
