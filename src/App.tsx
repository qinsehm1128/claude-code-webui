import type { PermissionResult, SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerEvent } from "./types";
import type { PermissionRequest } from "./store/useAppStore";
import { MessageCard } from "./components/EventCard";
import { DecisionPanel } from "./components/DecisionPanel";
import { Sidebar } from "./components/Sidebar";
import { PromptInput, usePromptActions } from "./components/PromptInput";
import { StartSessionModal } from "./components/StartSessionModal";
import { useWebSocket } from "./hooks/useWebSocket";
import { useAppStore } from "./store/useAppStore";
import MDContent from "./render/markdown";
import "./index.css";

export default function App() {
  // State from store
  const sessions = useAppStore((state) => state.sessions);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const prompt = useAppStore((state) => state.prompt);
  const cwd = useAppStore((state) => state.cwd);
  const pendingStart = useAppStore((state) => state.pendingStart);
  const globalError = useAppStore((state) => state.globalError);
  const sessionsLoaded = useAppStore((state) => state.sessionsLoaded);
  const showStartModal = useAppStore((state) => state.showStartModal);
  const historyRequested = useAppStore((state) => state.historyRequested);
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Actions from store
  const setPrompt = useAppStore((state) => state.setPrompt);
  const setCwd = useAppStore((state) => state.setCwd);
  const setShowStartModal = useAppStore((state) => state.setShowStartModal);
  const setActiveSessionId = useAppStore((state) => state.setActiveSessionId);
  const markHistoryRequested = useAppStore((state) => state.markHistoryRequested);
  const resolvePermissionRequest = useAppStore((state) => state.resolvePermissionRequest);
  const handleServerEvent = useAppStore((state) => state.handleServerEvent);

  // Local refs
  const streamEndRef = useRef<HTMLDivElement | null>(null);

  // WebSocket setup
  const onEvent = useCallback((event: ServerEvent) => {
    handleServerEvent(event);
    handlePartialMessages(event);
  }, [handleServerEvent]);

  const { connected, sendEvent } = useWebSocket(onEvent);

  const activeSession = activeSessionId ? sessions[activeSessionId] : undefined;

  const particalMessageRef = useRef("");
  const [particalMessage, setParticalMessage] = useState("");
  const [showParticalMessage, setShowParticalMessage] = useState(false);

  const getParticalMessageContent = (eventMessage: any) => {
    try {
      const realType = eventMessage.delta.type.split("_")[0]
      return eventMessage.delta[realType]
    } catch (error) {
      console.error(error);
      return ""
    }
  }

  const handlePartialMessages = (particalEvent: ServerEvent) => {
    if (particalEvent.type !== "stream.message" || particalEvent.payload.message.type !== "stream_event") return;

    const message = particalEvent.payload.message as any;
    if (message.event.type === "content_block_start") {
      particalMessageRef.current = ""
      setParticalMessage(particalMessageRef.current)
      setShowParticalMessage(true)
    }

    if (message.event.type === "content_block_delta") {
      particalMessageRef.current += getParticalMessageContent(message.event) || "";
      setParticalMessage(particalMessageRef.current)
      streamEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }

    if (message.event.type === "content_block_stop") {
      setShowParticalMessage(false)
      setTimeout(() => {
        particalMessageRef.current = ""
        setParticalMessage(particalMessageRef.current)
      }, 500)
    }
  };

  // Initial session load
  useEffect(() => {
    if (!connected) return;
    sendEvent({ type: "session.list" });
  }, [connected, sendEvent]);

  useEffect(() => {
    if (!showStartModal) return;
    const controller = new AbortController();
    fetch(`/api/sessions/recent-cwd?limit=8`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(response)))
      .then((data) => {
        if (data && Array.isArray(data.cwds)) {
          setRecentCwds(data.cwds);
        } else {
          setRecentCwds([]);
        }
      })
      .catch(() => {
        setRecentCwds([]);
      });

    return () => controller.abort();
  }, [showStartModal]);

  // History loading
  useEffect(() => {
    if (!connected || !activeSessionId) return;
    const session = sessions[activeSessionId];
    if (!session || session.hydrated) return;

    if (historyRequested.has(activeSessionId)) return;

    markHistoryRequested(activeSessionId);
    sendEvent({
      type: "session.history",
      payload: { sessionId: activeSessionId }
    });
  }, [connected, activeSessionId, sessions, historyRequested, markHistoryRequested, sendEvent]);

  // Auto-scroll when new messages are added
  const messagesLength = activeSession?.messages.length ?? 0;

  useEffect(() => {
    if (!streamEndRef.current) return;
    streamEndRef.current.scrollIntoView({ behavior: "smooth" });
  }, [messagesLength, particalMessage]);

  // Handlers
  const { handleStartFromModal } = usePromptActions(sendEvent);

  const handleNewSessionClick = () => {
    setActiveSessionId(null);
    setPrompt("");
    setCwd("");
    setShowStartModal(true);
  };

  const handlePermissionResponse = (
    request: PermissionRequest,
    result: PermissionResult
  ) => {
    if (!activeSessionId) return;
    sendEvent({
      type: "permission.response",
      payload: {
        sessionId: activeSessionId,
        toolUseId: request.toolUseId,
        result
      }
    });

    resolvePermissionRequest(activeSessionId, request.toolUseId);
  };

  return (
    <div className="h-full bg-surface">
      <div className="relative flex h-full flex-col lg:block">
        <Sidebar
          connected={connected}
          onNewSession={handleNewSessionClick}
          onDeleteSession={(sessionId) =>
            sendEvent({ type: "session.delete", payload: { sessionId } })
          }
          isMobileOpen={isSidebarOpen}
          onMobileClose={() => setIsSidebarOpen(false)}
        />

        <main className="relative flex min-h-full flex-col gap-6 px-4 sm:px-6 py-8 pb-36 lg:ml-[280px] bg-surface-cream overflow-x-hidden">
          <button
            className="fixed left-4 top-4 rounded-full border border-ink-900/10 bg-white p-2 text-ink-700 shadow-sm hover:bg-surface-tertiary lg:hidden"
            onClick={() => setIsSidebarOpen(true)}
            aria-label="Open sessions menu"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          {globalError && (
            <div className="rounded-xl border border-error/20 bg-error-light p-4 text-sm text-error">
              {globalError}
            </div>
          )}

          {activeSession && activeSession.permissionRequests.length > 0 && (
            <DecisionPanel
              request={activeSession.permissionRequests[activeSession.permissionRequests.length - 1]}
              onSubmit={(result) =>
                handlePermissionResponse(activeSession.permissionRequests[activeSession.permissionRequests.length - 1], result)
              }
            />
          )}

          <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col">
            <div className="text-xs font-medium text-muted mb-4">Stream</div>
            <div className="flex flex-col gap-4 mb-24 md:mb-16 lg:mb-0">
              {activeSession?.messages.length ? (
                activeSession.messages.map((message, index) => {
                  const isLast = index === activeSession.messages.length - 1;
                  const showIndicator = isLast && activeSession.status === "running";
                  const key = "uuid" in message ? message.uuid : `msg-${index}`;
                  return (
                    <MessageCard
                      key={key}
                      message={message}
                      showIndicator={showIndicator}
                      permissionRequests={activeSession?.permissionRequests}
                      onPermissionResponse={handlePermissionResponse}
                    />
                  );
                })
              ) : (
                <div className="rounded-xl border border-ink-900/10 bg-white px-6 py-8 text-center text-sm text-muted shadow-soft">
                  No stream output yet. Start a session or select one from the sidebar.
                </div>
              )}

              <div className="partical-message">
                <MDContent text={particalMessage} />
                {/* 模拟文本显示的骨架屏 */}
                {
                  showParticalMessage && <div className="mt-3 flex flex-col gap-2 px-1">
                    <div className="relative h-3 w-2/12 overflow-hidden rounded-full bg-ink-900/10">
                      <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-ink-900/30 to-transparent animate-shimmer" />
                    </div>
                    <div className="relative h-3 w-12/12 overflow-hidden rounded-full bg-ink-900/10">
                      <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-ink-900/30 to-transparent animate-shimmer" />
                    </div>
                    <div className="relative h-3 w-12/12 overflow-hidden rounded-full bg-ink-900/10">
                      <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-ink-900/30 to-transparent animate-shimmer" />
                    </div>
                    <div className="relative h-3 w-12/12 overflow-hidden rounded-full bg-ink-900/10">
                      <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-ink-900/30 to-transparent animate-shimmer" />
                    </div>
                    <div className="relative h-3 w-4/12 overflow-hidden rounded-full bg-ink-900/10">
                      <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-ink-900/30 to-transparent animate-shimmer" />
                    </div>
                  </div>
                }
              </div>
            </div>
          </section>
          <div ref={streamEndRef} />

          {activeSessionId && (
            <PromptInput
              sendEvent={sendEvent}
            />
          )}
        </main>
      </div>
      {sessionsLoaded && showStartModal && (
        <StartSessionModal
          cwd={cwd}
          prompt={prompt}
          pendingStart={pendingStart}
          recentCwds={recentCwds}
          onCwdChange={setCwd}
          onPromptChange={setPrompt}
          onStart={handleStartFromModal}
          onClose={() => setShowStartModal(false)}
        />
      )}
    </div>
  );
}
