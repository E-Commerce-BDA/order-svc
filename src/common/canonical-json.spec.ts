import { canonicalJson } from './canonical-json.js';

describe('canonicalJson', () => {
  it('orders object keys regardless of how the caller wrote them', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested objects and objects inside arrays', () => {
    expect(
      canonicalJson({ items: [{ qty: 1, productId: 'p' }], note: 'x' }),
    ).toBe('{"items":[{"productId":"p","qty":1}],"note":"x"}');
  });

  it('keeps array order, because array order is part of the request', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('drops undefined values the way JSON.stringify does', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});
