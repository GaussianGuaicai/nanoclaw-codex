# Intent: Add iMessage channel import

Add `import './imessage.js';` to the channel barrel file so the optional
`imessage` channel self-registers when this skill is applied.

This is an append-only change. Existing imports for other channels must remain
intact, and the public channel name must stay `imessage`.
