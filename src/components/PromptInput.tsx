import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientEvent } from "../types";
import { useAppStore } from "../store/useAppStore";

const DEFAULT_ALLOWED_TOOLS = "Read,Edit,Bash";

interface PromptInputProps {
  sendEvent: (event: ClientEvent) => void;
}

export function usePromptActions(sendEvent: (event: ClientEvent) => void) {
  const prompt = useAppStore((state) => state.prompt);
  const cwd = useAppStore((state) => state.cwd);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const sessions = useAppStore((state) => state.sessions);
  const setPrompt = useAppStore((state) => state.setPrompt);
  const setPendingStart = useAppStore((state) => state.setPendingStart);
  const setGlobalError = useAppStore((state) => state.setGlobalError);

  const activeSession = activeSessionId ? sessions[activeSessionId] : undefined;
  const isRunning = activeSession?.status === "running";
  const pendingStart = useAppStore((state) => state.pendingStart);

  const handleSend = useCallback(async () => {
    if (!prompt.trim()) return;

    if (!activeSessionId) {
      // Guard against double-submission
      if (pendingStart) return;

      let title = "";
      try {
        setPendingStart(true);
        const response = await fetch(`/api/sessions/title?userInput=${encodeURIComponent(prompt)}`);
        const data = await response.json();
        title = data.title;
      } catch (error) {
        console.error(error);
        setPendingStart(false);
        setGlobalError("Failed to get session title.");
        return;
      }
      sendEvent({
        type: "session.start",
        payload: {
          title,
          prompt,
          cwd: cwd.trim() || undefined,
          allowedTools: DEFAULT_ALLOWED_TOOLS
        }
      });
    } else {
      if (activeSession?.status === "running") {
        setGlobalError("Session is still running. Please wait for it to finish.");
        return;
      }
      sendEvent({
        type: "session.continue",
        payload: {
          sessionId: activeSessionId,
          prompt
        }
      });
    }

    setPrompt("");
  }, [
    activeSession,
    activeSessionId,
    cwd,
    pendingStart,
    prompt,
    sendEvent,
    setGlobalError,
    setPendingStart,
    setPrompt
  ]);

  const handleStop = useCallback(() => {
    if (!activeSessionId) return;
    sendEvent({
      type: "session.stop",
      payload: { sessionId: activeSessionId }
    });
  }, [activeSessionId, sendEvent]);

  const handleStartFromModal = useCallback(() => {
    if (!cwd.trim()) {
      setGlobalError("Working Directory is required to start a session.");
      return;
    }
    handleSend();
  }, [cwd, handleSend, setGlobalError]);

  return {
    prompt,
    setPrompt,
    isRunning,
    handleSend,
    handleStop,
    handleStartFromModal
  };
}

export function PromptInput({ sendEvent }: PromptInputProps) {
  const { prompt, setPrompt, isRunning, handleSend, handleStop } = usePromptActions(sendEvent);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (isRunning) {
      handleStop();
      return;
    }
    handleSend();
  };

  const handleInput = (event: React.FormEvent<HTMLTextAreaElement>) => {
    const target = event.currentTarget;
    target.style.height = "auto";
    target.style.height = `${target.scrollHeight}px`;
  };

  useEffect(() => {
    if (!promptRef.current) return;
    promptRef.current.style.height = "auto";
    promptRef.current.style.height = `${promptRef.current.scrollHeight}px`;
  }, [prompt]);

  return (
    <section className="fixed bottom-0 left-0 right-0 bg-gradient-to-t from-surface via-surface to-transparent pb-2 px-2 lg:pb-6 pt-8 lg:ml-[280px]">
      <div className="mx-auto flex w-full max-w-3xl items-end gap-3 rounded-2xl border border-ink-900/10 bg-surface px-4 py-3 shadow-card">
        <textarea
          rows={1}
          className="flex-1 resize-none bg-transparent py-1.5 text-sm text-ink-800 placeholder:text-muted focus:outline-none"
          placeholder="Describe the task you want Claude Code to handle..."
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          ref={promptRef}
        />
        <button
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${isRunning
            ? "bg-error text-white hover:bg-error/90"
            : "bg-accent text-white hover:bg-accent-hover"
            }`}
          onClick={isRunning ? handleStop : handleSend}
          aria-label={isRunning ? "Stop session" : "Send prompt"}
        >
          {isRunning ? (
            <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
              <path
                d="M3.4 20.6 21 12 3.4 3.4l2.8 7.2L16 12l-9.8 1.4-2.8 7.2Z"
                fill="currentColor"
              />
            </svg>
          )}
        </button>
      </div>
    </section>
  );
}
