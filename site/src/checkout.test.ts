import { describe, expect, it } from 'vitest';
import { checkoutStateAfter, paddleLocale, transactionIdFrom } from './checkout.ts';

describe('paddleLocale', () => {
  it('付款畫面的語言跟網站相同', () => {
    expect(paddleLocale('zh-tw')).toBe('zh-Hant');
    expect(paddleLocale('en')).toBe('en');
  });
});

describe('checkoutStateAfter', () => {
  it('overlay 載入後是 open，關掉後是 closed', () => {
    expect(checkoutStateAfter('loading', 'checkout.loaded')).toBe('open');
    expect(checkoutStateAfter('open', 'checkout.closed')).toBe('closed');
  });

  it('付款完成後關掉 overlay 仍然是 completed', () => {
    expect(checkoutStateAfter('open', 'checkout.completed')).toBe('completed');
    expect(checkoutStateAfter('completed', 'checkout.closed')).toBe('completed');
  });

  it('Paddle 回報錯誤時是 failed', () => {
    expect(checkoutStateAfter('loading', 'checkout.error')).toBe('failed');
  });

  it('其他事件（填表過程）不改變狀態', () => {
    expect(checkoutStateAfter('open', 'checkout.customer.created')).toBe('open');
  });
});

describe('transactionIdFrom', () => {
  it('讀出網址 _ptxn 的 transaction id', () => {
    expect(transactionIdFrom('?_ptxn=txn_01abc')).toBe('txn_01abc');
  });

  it('沒有 _ptxn 或不是 transaction id 時是 null', () => {
    expect(transactionIdFrom('')).toBeNull();
    expect(transactionIdFrom('?_ptxn=')).toBeNull();
    expect(transactionIdFrom('?_ptxn=sub_01abc')).toBeNull();
  });
});
