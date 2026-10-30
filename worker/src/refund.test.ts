/**
 * 退款的訂閱要取消（REFUND.md）：Paddle 核准全額退款後並不會取消訂閱（sandbox 實測，訂閱照樣 active、到期還會續約），
 * 所以 Worker 收到 adjustment.updated 時自己立即取消。從 HTTP 觀察：webhook 的回應與送給（假的）Paddle API 的請求。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signIn } from './test/http.ts';
import { adjustmentEvent, checkoutAccountId, fakePaddle, subscriptionEvent, webhook } from './test/paddle.ts';

const canceled = () => Response.json({ data: { id: 'sub_test', status: 'canceled' } });

afterEach(() => {
  vi.restoreAllMocks();
});

/** 有一筆 active 訂閱的 Account，回傳它的 Paddle subscription id。 */
async function subscribed(status = 'active'): Promise<string> {
  const accountId = await checkoutAccountId(await signIn());
  await webhook(subscriptionEvent({ accountId, status }));
  return `sub_test_${accountId}`;
}

describe('全額退款核准後立即取消訂閱', () => {
  it('後台的全額退款（最上層 type 是 partial、item 都是 full）：對 Paddle 送出立即取消', async () => {
    const subscriptionId = await subscribed();
    const paddle = fakePaddle([canceled]);

    expect((await webhook(adjustmentEvent({ subscriptionId }))).status).toBe(200);

    expect(paddle.calls).toEqual([
      expect.objectContaining({ url: `https://paddle.test/subscriptions/${subscriptionId}/cancel`, body: { effective_from: 'immediately' } }),
    ]);
  });

  it('最上層 type 是 full 的退款（API 建立的）也一樣取消', async () => {
    const subscriptionId = await subscribed();
    const paddle = fakePaddle([canceled]);

    await webhook(adjustmentEvent({ subscriptionId, type: 'full', itemTypes: [] }));

    expect(paddle.calls).toHaveLength(1);
  });

  it('同一個事件重送：只取消一次', async () => {
    const subscriptionId = await subscribed();
    const event = adjustmentEvent({ subscriptionId });
    const paddle = fakePaddle([canceled]);

    await webhook(event);
    await webhook(event);

    expect(paddle.calls).toHaveLength(1);
  });

  it('Paddle 取消失敗：回 5xx 讓 Paddle 重送，重送成功時才取消', async () => {
    const subscriptionId = await subscribed();
    const event = adjustmentEvent({ subscriptionId });
    fakePaddle([() => Response.json({ error: { code: 'internal_error' } }, { status: 500 })]);

    expect((await webhook(event)).status).toBeGreaterThanOrEqual(500);

    vi.restoreAllMocks();
    const paddle = fakePaddle([canceled]);
    expect((await webhook(event)).status).toBe(200);
    expect(paddle.calls).toHaveLength(1);
  });
});

describe('不取消', () => {
  const cases: [string, (subscriptionId: string) => ReturnType<typeof adjustmentEvent>][] = [
    ['部分退款（有 item 是 partial）', (subscriptionId) => adjustmentEvent({ subscriptionId, itemTypes: ['partial'] })],
    ['還在等 Paddle 核准', (subscriptionId) => adjustmentEvent({ subscriptionId, status: 'pending_approval', eventType: 'adjustment.created' })],
    ['Paddle 拒絕退款', (subscriptionId) => adjustmentEvent({ subscriptionId, status: 'rejected' })],
    ['不是退款（credit）', (subscriptionId) => adjustmentEvent({ subscriptionId, action: 'credit' })],
  ];
  for (const [name, event] of cases) {
    it(name, async () => {
      const subscriptionId = await subscribed();
      const paddle = fakePaddle([]);

      expect((await webhook(event(subscriptionId))).status).toBe(200);

      expect(paddle.calls).toEqual([]);
    });
  }

  it('不是我們的訂閱（同一個 Paddle 帳號底下其他產品的退款）', async () => {
    const paddle = fakePaddle([]);

    expect((await webhook(adjustmentEvent({ subscriptionId: 'sub_someone_else' }))).status).toBe(200);

    expect(paddle.calls).toEqual([]);
  });

  it('訂閱已經是 canceled', async () => {
    const subscriptionId = await subscribed('canceled');
    const paddle = fakePaddle([]);

    await webhook(adjustmentEvent({ subscriptionId }));

    expect(paddle.calls).toEqual([]);
  });
});
