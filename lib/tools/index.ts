import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRequestApiKey } from "@/lib/opendart/client";
import { registerCompanyTools } from "./company";
import { registerFinancialTools } from "./financial";
import { registerDisclosureTools } from "./disclosure";
import { registerShareholdingTools } from "./shareholding";
import { registerMajorEventTools } from "./major-events";
import { registerSecuritiesRegTools } from "./securities-reg";
import { registerWorkflowTools } from "./workflows";
import { registerDocumentTools } from "./document";
import { registerDaTools } from "./da";

function registerConfigTools(server: McpServer) {
  // set_api_key 는 키를 서버 전역에 저장해 다른 사용자와 공유되는 문제가 있어 더 이상 키를 저장하지 않는다.
  // (stateless 서버라 요청 간에 사용자별로 키를 보관할 안전한 방법이 없다.) 기존 클라이언트를 위해 도구는 남겨 두고 안내만 한다.
  server.tool(
    "set_api_key",
    "DEPRECATED — does not store the key. Put ?opendart_key=YOUR_KEY in the connector URL, or pass api_key to each tool. / " +
      "더 이상 키를 저장하지 않습니다. 커넥터 URL에 ?opendart_key=본인키 를 넣거나 도구마다 api_key 를 넘기세요.",
    { api_key: z.string().describe("Ignored / 사용되지 않음") },
    async () => ({
      content: [
        {
          type: "text" as const,
          text:
            "set_api_key no longer stores keys: on this stateless server a stored key would be shared with other users. " +
            "Add ?opendart_key=YOUR_KEY to the connector URL, or pass api_key to each tool call. / " +
            "보안상 set_api_key 로는 키를 저장하지 않습니다(저장하면 다른 사용자와 키가 공유됨). " +
            "커넥터 URL에 ?opendart_key=본인키 를 넣거나, 도구 호출 시 api_key 인자로 넘기세요.",
        },
      ],
      isError: true,
    })
  );

  server.tool(
    "get_api_key_status",
    "Check whether an OpenDART API key is configured. / OpenDART API 키 설정 여부를 확인합니다.",
    {},
    async () => {
      const hasRequest = !!getRequestApiKey();
      const hasEnv = !!process.env.OPENDART_API_KEY;

      let status: string;
      if (hasRequest) {
        status = "API key is provided via the connector URL (?opendart_key=). / 커넥터 URL(?opendart_key=)로 API 키가 전달되었습니다.";
      } else if (hasEnv) {
        status = "Server API key is configured (environment variable). / 서버 API 키(환경변수)가 설정되어 있습니다.";
      } else {
        status =
          "No API key configured. Add ?opendart_key=YOUR_KEY to the connector URL or pass api_key to each tool. " +
          "Get one free at https://opendart.fss.or.kr/ / " +
          "API 키가 설정되지 않았습니다. 커넥터 URL에 ?opendart_key=본인키 를 넣거나 도구의 api_key 인자로 넘기세요. " +
          "https://opendart.fss.or.kr/ 에서 무료로 발급받을 수 있습니다.";
      }

      return { content: [{ type: "text" as const, text: status }] };
    }
  );
}

export function registerAllTools(server: McpServer) {
  registerConfigTools(server);         // API key configuration (first)
  registerWorkflowTools(server);       // Workflow tools (most useful)
  registerCompanyTools(server);        // Company search & info
  registerFinancialTools(server);      // Financial statements & indicators
  registerDisclosureTools(server);     // Periodic report details
  registerShareholdingTools(server);   // Shareholding disclosures
  registerMajorEventTools(server);     // Major corporate events
  registerSecuritiesRegTools(server);  // Securities registration statements
  registerDocumentTools(server);       // Original disclosure document (document.xml)
  registerDaTools(server);             // D&A extraction for EBITDA (listed companies)
}
