// Cursor 3.17.21 includes its legacy app callback in dynamic registration,
// even when the active redirect uses localhost. Keep the exact value shared
// with the consent page; accepting a generic cursor: scheme would be broader.
export const CURSOR_DESKTOP_REDIRECT_URI = "cursor://anysphere.cursor-mcp/oauth/callback";

// Cursor's documented callback for web/Agents: https://cursor.com/docs/mcp
export const CURSOR_HOSTED_REDIRECT_URI = "https://www.cursor.com/agents/mcp/oauth/callback";
