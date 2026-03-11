import { useEffect, useRef, useState } from "react";
import type {
  PermissionResult,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import type { StreamMessage } from "../types";
import type { PermissionRequest } from "../store/useAppStore";
import MDContent from "../render/markdown";
import { DecisionPanel } from "./DecisionPanel";
type MessageContent = SDKAssistantMessage["message"]["content"]
let toolUseMap = new Map();
type ToolStatus = "pending" | "success" | "error";
const toolStatusMap = new Map<string, ToolStatus>();
const toolStatusListeners = new Set<() => void>();
const MAX_VISIBLE_LINES = 3;

type AskUserQuestionInput = {
  questions?: Array<{
    question: string;
    header?: string;
    options?: Array<{
      label: string;
      description?: string;
    }>;
    multiSelect?: boolean;
  }>;
};

const getAskUserQuestionSignature = (input?: AskUserQuestionInput | null) => {
  if (!input?.questions?.length) return "";
  return input.questions.map((question) => {
    const options = (question.options ?? [])
      .map((option) => `${option.label}|${option.description ?? ""}`)
      .join(",");
    return `${question.question}|${question.header ?? ""}|${question.multiSelect ? "1" : "0"}|${options}`;
  }).join("||");
};

const setToolStatus = (toolUseId: string | undefined, status: ToolStatus) => {
  if (!toolUseId) {
    return;
  }
  toolStatusMap.set(toolUseId, status);
  toolStatusListeners.forEach((listener) => listener());
};

const useToolStatus = (toolUseId: string | undefined) => {
  const [status, setStatus] = useState<ToolStatus | undefined>(() => (
    toolUseId ? toolStatusMap.get(toolUseId) : undefined
  ));

  useEffect(() => {
    if (!toolUseId) {
      return;
    }
    const handleUpdate = () => {
      setStatus(toolStatusMap.get(toolUseId));
    };
    toolStatusListeners.add(handleUpdate);
    return () => {
      toolStatusListeners.delete(handleUpdate);
    };
  }, [toolUseId]);

  return status;
};

const StatusDot = ({
  variant = "accent",
  isActive = false,
  isVisible = true
}: {
  variant?: "accent" | "success" | "error";
  isActive?: boolean;
  isVisible?: boolean;
}) => {
  if (!isVisible) {
    return null;
  }
  const colorClass = variant === "success" ? "bg-success" : variant === "error" ? "bg-error" : "bg-accent";
  return (
    <span className="relative flex h-2 w-2">
      {isActive && (
        <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${colorClass} opacity-75`}></span>
      )}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${colorClass}`}></span>
    </span>
  );
};

const SessionResult = ({
  message,
}: {
  message: SDKResultMessage;
}) => {
  const formatMinutes = (ms: number | undefined) => {
    if (typeof ms !== "number") {
      return "-";
    }
    return `${(ms / 60000).toFixed(2)} min`;
  };

  const formatUsd = (usd: number | undefined) => {
    if (typeof usd !== "number") {
      return "-";
    }
    return usd.toFixed(2);
  };

  const formatMillions = (tokens: number | undefined) => {
    if (typeof tokens !== "number") {
      return "-";
    }
    return `${(tokens / 1_000_000).toFixed(4)} M`;
  };

  return (
    <div className="flex flex-col gap-2 mt-4">
      <div className="header text-accent-main-100">
        Session Result
      </div>
      <div className="flex flex-col bg-bg-200 border-border-100/10 rounded-xl px-4 py-3 border border-[0.5px] bg-bg-100 space-y-2 dark:bg-bg-300">
        <div className="flex flex-wrap items-center gap-2 text-[14px]">
          <span className="font-normal">Duration</span>
          <span className="inline-flex items-center rounded-full bg-bg-300 px-2.5 py-0.5 text-ink-700 text-[13px]">
            {formatMinutes(message.duration_ms)}
          </span>
          <span className="font-normal">API</span>
          <span className="inline-flex items-center rounded-full bg-bg-300 px-2.5 py-0.5 text-ink-700 text-[13px]">
            {formatMinutes(message.duration_api_ms)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[14px]">
          <span className="font-normal">Usage</span>
          <span className="inline-flex items-center rounded-full bg-accent/10 px-2.5 py-0.5 text-accent text-[13px]">
            Cost ${formatUsd(message.total_cost_usd)}
          </span>
          <span className="inline-flex items-center rounded-full bg-bg-300 px-2.5 py-0.5 text-ink-700 text-[13px]">
            Input {formatMillions(message.usage?.input_tokens)}
          </span>
          <span className="inline-flex items-center rounded-full bg-bg-300 px-2.5 py-0.5 text-ink-700 text-[13px]">
            Output {formatMillions(message.usage?.output_tokens)}
          </span>
        </div>
      </div>
    </div>
  )
}

export function isMarkdown(text: string): boolean {
  if (!text || typeof text !== "string") return false

  const patterns: RegExp[] = [
    /^#{1,6}\s+/m,                 // 标题
    /```[\s\S]*?```/,              // 代码块
  ]

  return patterns.some((pattern) => pattern.test(text))
}


function hasProp(
  obj: unknown,
  key: PropertyKey
): obj is Record<PropertyKey, unknown> {
  return typeof obj === "object" && obj !== null && key in obj
}

function extractTagContent(
  input: string,
  tag: string
): string | null {
  const match = input.match(
    new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)
  );
  return match ? match[1] : null;
}

const ToolResult = ({
  message,
  messageContent,
}: {
  message: SDKUserMessage;
  messageContent: MessageContent;
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const isFirstRender = useRef(true);
  let lines: string[] = [];
  const toolUseId = "tool_use_id" in messageContent && typeof messageContent.tool_use_id === "string"
    ? messageContent.tool_use_id
    : undefined;
  const status: ToolStatus = messageContent.is_error ? "error" : "success";

  const isError = messageContent.is_error;
  if (messageContent.is_error) {
    lines = [extractTagContent(messageContent.content, "tool_use_error") || ""]
  } else {
    try {
      if (Array.isArray(messageContent.content)) {
        lines = messageContent.content.map((item: any) => item.text).join("\n").split("\n");
      } else {
        lines = messageContent.content.split("\n");
      }
    } catch (error) {
      console.error("Failed to split content into lines:", error);
      lines = [JSON.stringify(message, null, 2)];
    }
  }

  const isMarkdownContent = isMarkdown(lines.join("\n"));

  const hasMoreLines = lines.length > MAX_VISIBLE_LINES;
  const visibleContent = hasMoreLines && !isExpanded
    ? lines.slice(0, MAX_VISIBLE_LINES).join("\n")
    : lines.join("\n");

  useEffect(() => {
    setToolStatus(toolUseId, status);
  }, [toolUseId, status]);

  useEffect(() => {
    if (!hasMoreLines) {
      return;
    }
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [hasMoreLines, isExpanded]);

  return (
    <div className="flex flex-col mt-4">
      <div className="header text-accent-main-100">
        Output
      </div>
      <div className="mt-2 rounded-xl bg-surface-tertiary p-3 overflow-hidden">
        <pre className={`text-sm whitespace-pre-wrap break-words font-mono overflow-x-auto ${isError ? "text-red-500" : "text-ink-700"}`}>
          {isMarkdownContent ?
            <div>
              Markdown
              <MDContent text={visibleContent} />
            </div>
            :
            visibleContent
          }
        </pre>
        {hasMoreLines && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="mt-2 text-sm text-accent hover:text-accent-hover transition-colors flex items-center gap-1"
          >
            <span>{isExpanded ? "▲" : "▼"}</span>
            <span>
              {isExpanded
                ? "Collapse"
                : `Show ${lines.length - MAX_VISIBLE_LINES} more lines`}
            </span>
          </button>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

const AssistantBlockCard = ({
  title,
  text,
  showIndicator = false
}: {
  title: string;
  text: string;
  showIndicator?: boolean;
}) => {
  return (
    <div className="flex flex-col mt-4">
      <div className="header text-accent-main-100 flex items-center gap-2">
        <StatusDot variant="success" isActive={showIndicator} isVisible={showIndicator} />
        {title}
      </div>
      <MDContent text={text} />
    </div>
  );
};

const ToolUseCard = ({
  messageContent,
  showIndicator = false,
}: {
  messageContent: MessageContent;
  showIndicator?: boolean;
}) => {
  const toolStatus = useToolStatus(messageContent.id);
  const statusVariant = toolStatus === "error" ? "error" : "success";
  const isPending = !toolStatus || toolStatus === "pending";
  const shouldShowDot = toolStatus === "success" || toolStatus === "error" || showIndicator;

  useEffect(() => {
    if (messageContent?.id && !toolStatusMap.has(messageContent.id)) {
      setToolStatus(messageContent.id, "pending");
    }
  }, [messageContent?.id]);
  const getToolInfo = (): string | null => {
    switch (messageContent.name) {
      case "Bash":
        return messageContent.input.command || null;
      case "Read":
      case "Write":
      case "Edit":
        return messageContent.input.file_path || null;
      case "Glob":
        return messageContent.input.pattern || null;
      case "Grep":
        return messageContent.input.pattern || null;
      case "Task":
        return messageContent.input.description || null;
      case "WebFetch":
        return messageContent.input.url || null;
      default:
        console.log("toolInfo None", messageContent)
        return null;
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-[1rem] bg-bg-300 px-3 py-2 mt-4 overflow-hidden">
      <div className="flex flex-row items-center gap-2 min-w-0">
        <StatusDot
          variant={statusVariant}
          isActive={isPending && showIndicator}
          isVisible={shouldShowDot}
        />
        <div className="flex flex-row items-center gap-2 tool-use-item min-w-0 overflow-hidden">
          <span className="inline-flex items-center rounded-md text-accent py-0.5 text-sm font-medium shrink-0">
            {messageContent.name}
          </span>
          <span className="text-sm text-muted truncate">
            {getToolInfo()}
          </span>
        </div>
      </div>
    </div>
  );
}

const AskUserQuestionCard = ({
  messageContent,
  permissionRequests,
  onPermissionResponse,
  showIndicator = false
}: {
  messageContent: MessageContent;
  permissionRequests?: PermissionRequest[];
  onPermissionResponse?: (request: PermissionRequest, result: PermissionResult) => void;
  showIndicator?: boolean;
}) => {
  const toolStatus = useToolStatus(messageContent.id);
  const statusVariant = toolStatus === "error" ? "error" : "success";
  const isPending = !toolStatus || toolStatus === "pending";
  const shouldShowDot = toolStatus === "success" || toolStatus === "error" || showIndicator;

  useEffect(() => {
    if (messageContent?.id && !toolStatusMap.has(messageContent.id)) {
      setToolStatus(messageContent.id, "pending");
    }
  }, [messageContent?.id]);

  const input = messageContent.input as AskUserQuestionInput | null;
  const questions = input?.questions ?? [];
  const signature = getAskUserQuestionSignature(input);
  const matchingRequest = permissionRequests?.find((request) => {
    if (request.toolName !== "AskUserQuestion") return false;
    const requestSignature = getAskUserQuestionSignature(request.input as AskUserQuestionInput | null);
    return requestSignature !== "" && requestSignature === signature;
  });

  if (matchingRequest && onPermissionResponse) {
    return (
      <div className="mt-4">
        <DecisionPanel
          request={matchingRequest}
          onSubmit={(result) => onPermissionResponse(matchingRequest, result)}
        />
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-accent/20 bg-accent-subtle p-5 mt-4">
      <div className="text-xs font-semibold text-accent flex items-center gap-2">
        <StatusDot
          variant={statusVariant}
          isActive={isPending && showIndicator}
          isVisible={shouldShowDot}
        />
        Question from Claude
      </div>

      {questions.length === 0 && (
        <div className="mt-3 text-sm text-ink-700">User input requested.</div>
      )}

      {questions.map((q, qIndex) => (
        <div key={qIndex} className="mt-4">
          <p className="text-sm text-ink-700">{q.question}</p>
          {q.header && (
            <span className="mt-2 inline-flex items-center rounded-full bg-surface px-2 py-0.5 text-xs text-muted">
              {q.header}
            </span>
          )}
          <div className="mt-3 grid gap-2">
            {(q.options ?? []).map((option, optIndex) => (
              <div
                key={optIndex}
                className="rounded-xl border border-ink-900/10 bg-surface px-4 py-3 text-left text-sm text-ink-700"
              >
                <div className="font-medium">{option.label}</div>
                {option.description && (
                  <div className="mt-1 text-xs text-muted">{option.description}</div>
                )}
              </div>
            ))}
          </div>
          {q.multiSelect && (
            <div className="mt-2 text-xs text-muted">Multiple selections allowed.</div>
          )}
        </div>
      ))}
    </div>
  );
};

const SystemInfoCard = ({ message, showIndicator = false }: { message: SDKSystemMessage; showIndicator?: boolean }) => {
  const InfoItem = ({ name, value }: { name: string, value: string }) => {
    return (
      <div className="text-[14px] min-w-0 overflow-hidden">
        <span className="mr-4 font-normal">{name}</span>
        <span className="font-light break-all">{value}</span>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="header text-accent-main-100 font-serif flex items-center gap-2">
        <StatusDot variant="success" isActive={showIndicator} isVisible={showIndicator} />
        System Init
      </div>
      <div className="flex flex-col bg-bg-200 border-border-100/10 rounded-xl px-4 py-2 border border-[0.5px] [&_label]:hidden bg-bg-100 space-y-1 dark:bg-bg-300 overflow-hidden">
        <InfoItem name={`Session ID`} value={message.session_id} />
        <InfoItem name={`Model Name`} value={message.model} />
        <InfoItem name={`Permission Mode`} value={message.permissionMode} />
        <InfoItem name={`Working Directory`} value={message.cwd} />
      </div>
    </div>
  );
}

const getMessageText = (contentBlock: Record<string, unknown>): string => {
  if (typeof contentBlock.text === "string") return contentBlock.text;
  if (typeof contentBlock.content === "string") return contentBlock.content;
  return JSON.stringify(contentBlock, null, 2);
};

const UserMessageCard = ({
  title,
  message,
  showIndicator = false
}: {
  title: string;
  message: SDKAssistantMessage | SDKUserMessage;
  showIndicator?: boolean;
}) => {
  return (
    <div className="flex flex-col mt-4">
      <div className="header text-accent-main-100 flex items-center gap-2">
        <StatusDot variant="success" isActive={showIndicator} isVisible={showIndicator} />
        {title}
      </div>
      {message.message.content.map((msg: any, index: number) => {
        return <MDContent key={index} text={getMessageText(msg)} />
      })}
    </div>
  )
}


export const MessageCard = function MessageCard({
  message,
  showIndicator = false,
  permissionRequests,
  onPermissionResponse
}: {
  message: StreamMessage;
  showIndicator?: boolean;
  permissionRequests?: PermissionRequest[];
  onPermissionResponse?: (request: PermissionRequest, result: PermissionResult) => void;
}) {


  // System init message
  if (message.type === "system" && "subtype" in message && message.subtype === "init") {
    return <SystemInfoCard message={message} showIndicator={showIndicator} />
  }

  if (message.type === "assistant" && message.message.content) {
    return message.message.content.map((messageContent: any, index: number) => {
      const isLastBlock = index === message.message.content.length - 1;
      const blockIndicator = showIndicator && isLastBlock;
      const key = typeof messageContent.id === "string" ? messageContent.id : `${messageContent.type}-${index}`;

      if (messageContent.type === "thinking") {
        const text = typeof messageContent.thinking === "string"
          ? messageContent.thinking
          : getMessageText(messageContent);
        return <AssistantBlockCard key={key} title="Thinking" text={text} showIndicator={blockIndicator} />;
      }

      if (messageContent.type === "text") {
        const text = typeof messageContent.text === "string"
          ? messageContent.text
          : getMessageText(messageContent);
        return <AssistantBlockCard key={key} title="Assistant" text={text} showIndicator={blockIndicator} />;
      }

      if (messageContent.type === "tool_use") {
        toolUseMap.set(messageContent.id, messageContent.name);
        if (messageContent.name === "AskUserQuestion") {
          return (
            <AskUserQuestionCard
              key={key}
              messageContent={messageContent}
              permissionRequests={permissionRequests}
              onPermissionResponse={onPermissionResponse}
              showIndicator={blockIndicator}
            />
          );
        }
        return <ToolUseCard key={key} messageContent={messageContent} showIndicator={blockIndicator} />;
      }

      return (
        <div key={key} className="rounded-xl border border-ink-900/10 bg-white pb-4 pt-0 px-4 shadow-soft overflow-hidden">
          <div>Unsupported assistant block</div>
          <pre className="mt-2 whitespace-pre-wrap break-words text-sm text-ink-600 font-mono overflow-x-auto">
            {JSON.stringify(messageContent, null, 2)}
          </pre>
        </div>
      );
    });
  }

  // User tool result
  if (message.type === "user" && message.message.content && message.message.content[0].type === "tool_result") {
    return message.message.content.map((messageContent: MessageContent, index: number) => {
      return <ToolResult key={index} message={message} messageContent={messageContent} />
    })
  }

  if (message.type === "user" && message.message.role === "user") {
    return <UserMessageCard title="User" message={message} showIndicator={showIndicator} />
  }

  if (message.type === "user_prompt") {
    return (
      <div className="flex flex-col mt-4">
        <div className="header text-accent-main-100 flex items-center gap-2">
          <StatusDot variant="success" isActive={showIndicator} isVisible={showIndicator} />
          User
        </div>
        <MDContent text={message.prompt} />
      </div>
    );
  }

  if (message.type === "stream_event") return null;

  if (message.type === "result") {
    return <SessionResult message={message} />
  }

  // Fallback for unknown message types
  return (
    <div className="rounded-xl border border-ink-900/10 bg-white pb-4 pt-0 px-4 shadow-soft overflow-hidden">
      <div>Unsupport message type {Math.floor(Date.now() / 1000)}</div>
      <pre className="mt-2 whitespace-pre-wrap break-words text-sm text-ink-600 font-mono overflow-x-auto">
        {JSON.stringify(message, null, 2)}
      </pre>
    </div>
  );
};

// Re-export as EventCard for backward compatibility
export const EventCard = MessageCard;
