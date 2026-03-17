# Intent: register iMessage channel in channel barrel

This patch adds a single self-registration import:

```ts
import './imessage.js';
```

## Invariants
- Keep all existing channel imports intact.
- Preserve comment structure where possible.
- Use `.js` extension to match NodeNext runtime imports.
