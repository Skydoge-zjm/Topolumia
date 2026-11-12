import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { api, projectId, ApiClientError } from "@/shared/lib/api";
import { useUnsavedChanges } from "@/features/research/useResearch";
import { CommonAgentSettings } from "./CommonAgentSettings";
import {
  parseConfig,
  serializeConfig,
  setConfigPath,
} from "./nativeConfigModel";
import type { NativeConfigDocument } from "./nativeConfigModel";
import type { ConfiguredAgent } from "./AgentConfigurationPage";
import "./NativeAgentConfig.css";
import { setOpenCodeV1Permission } from "./opencode/v1/permissions";
import { setOpenCodeV2Permission } from "./opencode/v2/permissions";

const configUrl = (id: string) =>
  `/api/agent-configuration/profiles/${encodeURIComponent(id)}/native-config`;

export function NativeAgentConfigEditor({
  agent,
  en,
  onClose,
  onSaved,
}: {
  agent: ConfiguredAgent;
  en: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const state = useRef({ dirty: false, busy: false });
  const close = () => {
    if (
      !state.current.busy &&
      (!state.current.dirty ||
        window.confirm(
          en ? "Discard unsaved configuration?" : "放弃未保存的配置？",
        ))
    )
      onClose();
  };
  const query = useQuery({
    queryKey: ["agent-native-config", projectId(), agent.id],
    queryFn: () => api<NativeConfigDocument>(configUrl(agent.id)),
    staleTime: 0,
    retry: false,
  });

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content aria-describedby={undefined} translate="no" className="native-config-dialog">
          <header className="native-config-header">
            <Dialog.Title>
              {agent.label} {en ? "configuration" : "配置"}
            </Dialog.Title>

            <button
              type="button"
              className="native-config-close"
              aria-label={en ? "Close configuration" : "关闭配置"}
              onClick={close}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </header>
          {query.isPending && (
            <p className="native-config-loading" role="status">
              {en ? "Reading configuration…" : "读取配置…"}
            </p>
          )}
          {query.error && (
            <p className="native-config-error" role="alert">
              {query.error.message}
            </p>
          )}
          {query.data && (
            <NativeConfigForm
              key={`${agent.id}:${query.data.revision}`}
              document={query.data}
              agent={agent}
              en={en}
              onClose={close}
              onSaved={onSaved}
              stateRef={state}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function NativeConfigForm({
  document: initial,
  agent,
  en,
  onClose,
  onSaved,
  stateRef,
}: {
  document: NativeConfigDocument;
  agent: ConfiguredAgent;
  en: boolean;
  onClose: () => void;
  onSaved: () => void;
  stateRef: { current: { dirty: boolean; busy: boolean } };
}) {
  const client = useQueryClient();
  const [source, setSource] = useState(initial.content);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const dirty = source !== initial.content;
  const busy = saving || reloading;
  useEffect(() => {
    stateRef.current = { dirty, busy };
  }, [dirty, busy, stateRef]);
  useUnsavedChanges(dirty && !busy);

  const parsed = useMemo(() => {
    try {
      return { value: parseConfig(agent.provider, source), error: "" };
    } catch (error) {
      return { value: null, error: (error as Error).message };
    }
  }, [agent.provider, source]);

  const update = (path: string[], item: any) => {
    if (!parsed.value) return;
    try {
      let next = setConfigPath(parsed.value, path, item);
      if (agent.provider === "codex" && path[0] === "sandbox_mode")
        next = setConfigPath(next, ["default_permissions"], undefined);
      if (agent.provider === "opencode" && path[0] === "permission")
        next = (initial.configKey === "opencode-v2" ? setOpenCodeV2Permission : setOpenCodeV1Permission)(parsed.value, item);
      setSource(serializeConfig(agent.provider, next));
      setError("");
    } catch (error) {
      setError((error as Error).message);
    }
  };

  return (
    <form
      className="native-config-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || parsed.error) return;
        setError("");
        setSaving(true);
        try {
          await api(configUrl(agent.id), {
            method: "PUT",
            body: JSON.stringify({
              content: source,
              expectedRevision: initial.revision,
            }),
          });
          await client.invalidateQueries({
            queryKey: ["agent-native-config", projectId(), agent.id],
          });
          onSaved();
        } catch (error) {
          const detail =
            error instanceof ApiClientError
              ? (error.detail as { line?: number; column?: number })
              : null;
          setError(
            (error as Error).message +
              (detail?.line ? ` ${detail.line}:${detail.column ?? 1}` : ""),
          );
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="native-config-body">
        <fieldset
          className="native-config-common"
          aria-label={en ? "Common settings" : "常用设置"}
          disabled={busy || !parsed.value}
        >
          <CommonAgentSettings
            agent={agent}
            configKey={initial.configKey}
            en={en}
            value={parsed.value ?? {}}
            update={update}
          />
        </fieldset>
        <div className="native-config-source">
          <div className="native-config-source-heading">
            <label htmlFor="native-config-source">{initial.filename}</label>
            <a href={initial.docsUrl} target="_blank" rel="noopener noreferrer">
              {en ? "Configuration reference ↗" : "配置参考 ↗"}
            </a>
          </div>
          <textarea
            id="native-config-source"
            aria-label={en ? "Configuration file content" : "配置文件内容"}
            aria-invalid={Boolean(parsed.error)}
            aria-describedby={
              parsed.error ? "native-config-syntax-error" : undefined
            }
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setError("");
            }}
            disabled={busy}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          {parsed.error && (
            <p
              id="native-config-syntax-error"
              className="native-config-error"
              role="alert"
            >
              {en ? "Check the configuration syntax: " : "请检查配置语法："}
              {parsed.error}
            </p>
          )}
        </div>
        {error && (
          <div className="native-config-error">
            <p role="alert">{error}</p>
            <button
              type="button"
              className="native-config-reload"
              disabled={busy}
              onClick={async () => {
                if (
                  dirty &&
                  !window.confirm(
                    en ? "Reload and discard changes?" : "重新载入并放弃修改？",
                  )
                )
                  return;
                setReloading(true);
                try {
                  const fresh = await client.fetchQuery({
                    queryKey: ["agent-native-config", projectId(), agent.id],
                    queryFn: () =>
                      api<NativeConfigDocument>(configUrl(agent.id)),
                    staleTime: 0,
                  });
                  setSource(fresh.content);
                  setError("");
                } catch (error) {
                  setError((error as Error).message);
                } finally {
                  setReloading(false);
                }
              }}
            >
              {en ? "Reload" : "重新载入"}
            </button>
          </div>
        )}
      </div>
      <footer className="native-config-footer">
        <span>{dirty ? (en ? "Unsaved changes" : "有未保存修改") : ""}</span>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={onClose}
        >
          {en ? "Cancel" : "取消"}
        </button>
        <button
          className="button primary"
          disabled={busy || Boolean(parsed.error)}
        >
          {saving
            ? en
              ? "Saving…"
              : "保存中…"
            : en
              ? "Save configuration"
              : "保存配置"}
        </button>
      </footer>
    </form>
  );
}
