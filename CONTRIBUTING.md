# Contributing

Issues and pull requests are welcome.

1. Use Node.js 24.
2. Create a focused branch.
3. Run `npm ci` and `npm run check`.
4. Add tests for behavioural changes.
5. Keep tools read-only unless a proposal explicitly documents and justifies a different security model.

Live ABS API tests are opt-in with `npm run test:live`; ordinary tests must use fixtures or mocked fetch responses.
