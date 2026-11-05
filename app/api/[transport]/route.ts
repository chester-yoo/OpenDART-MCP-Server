import { createMcpHandler } from "mcp-handler";
import { registerAllTools } from "@/lib/tools";
import { runWithRequestApiKey } from "@/lib/opendart/client";

const mcpHandler = createMcpHandler(
  (server) => {
    registerAllTools(server);
  },
  {
    capabilities: {},
  },
  {
    basePath: "/api",
    maxDuration: 60,
    verboseLogs: true,
  }
);

async function handler(req: Request) {
  const url = new URL(req.url);
  // 키는 이 요청 안에서만 유효하다(다른 사용자의 요청과 공유되지 않음).
  const apiKey = url.searchParams.get("opendart_key") ?? undefined;
  return runWithRequestApiKey(apiKey, () => mcpHandler(req));
}

export { handler as GET, handler as POST, handler as DELETE };
