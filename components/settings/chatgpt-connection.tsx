"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatGPTBridge, ChatGPTStatus } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";
import { SettingsGroup } from "./controls.tsx";

/** Uses the existing settings controls; no credentials or authorization URLs. */
export function ChatGPTConnection() {
	const [status, setStatus] = useState<ChatGPTStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const lastConnection = useRef("");
	useEffect(() => {
		const bridge = window.lh?.chatgpt;
		if (!bridge) return;
		let alive = true;
		const update = (next: ChatGPTStatus) => {
			if (!alive) return;
			setStatus(next);
			const key = JSON.stringify([next.mode, next.selectedId, next.authenticated, next.planPermission, next.modelIds]);
			if (lastConnection.current && lastConnection.current !== key) notifySettingsSaved("keys");
			lastConnection.current = key;
		};
		const unsubscribe = bridge.onStatus(update);
		void bridge.status().then(update).catch(() => {}); // external Next dev has no managed credential channel
		return () => { alive = false; unsubscribe(); };
	}, []);
	if (!status?.desktop) return null;
	const connected = status.authenticated && status.planPermission;
	const button = "rounded-sm border border-border px-3 py-1.5 text-xs text-foreground hover:border-muted-foreground/50 disabled:opacity-40";
	async function run(action: (bridge: ChatGPTBridge) => Promise<ChatGPTStatus>) {
		const bridge = window.lh?.chatgpt;
		if (!bridge) return;
		setBusy(true); setError(null);
		try { setStatus(await action(bridge)); notifySettingsSaved("keys"); }
		catch (err) { setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : "ChatGPT connection failed."); }
		finally { setBusy(false); }
	}
	return (
		<SettingsGroup label="ChatGPT" testid="chatgpt-connection">
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-xs text-muted-foreground" role="status">{status.pending ? "Waiting for browser sign-in…" : status.mode === "chatgpt" ? connected ? "Connected · using ChatGPT plan" : "ChatGPT disconnected" : "OpenAI uses API-key billing"}</span>
				<button type="button" className={`${button} ml-auto`} onClick={() => void run((b) => b.manageUsage())}>Manage usage ↗</button>
			</div>
			{status.accounts.length > 0 && (
				<label className="flex items-center gap-3 text-xs">
					Saved account
					<select aria-label="ChatGPT account" className="min-w-0 flex-1 rounded-sm border border-border bg-background p-1.5 text-foreground" disabled={busy || status.pending} value={status.selectedId ?? ""} onChange={(e) => void run((b) => b.select(e.target.value))}>
						<option value="" disabled>Select an account</option>
						{status.accounts.map((a, i) => <option key={a.id} value={a.id}>{a.label}{status.accounts.filter((p) => p.label === a.label).length > 1 ? ` (${i + 1})` : ""}{a.connected ? "" : " · signed out"}</option>)}
					</select>
				</label>
			)}
			<div className="flex flex-wrap gap-2">
				{status.pending ? (
					<button type="button" className={button} onClick={() => void window.lh?.chatgpt?.cancel()}>Cancel sign-in</button>
				) : (
					<>
						<button type="button" className={button} disabled={busy} onClick={() => void run((b) => b.signIn(status.selectedId ?? undefined))}>Continue with ChatGPT</button>
						{status.selectedId && <button type="button" className={button} disabled={busy} onClick={() => void run((b) => b.signIn())}>Add account</button>}
						{status.authenticated && status.selectedId && <button type="button" className={button} disabled={busy} onClick={() => void run((b) => b.signOut(status.selectedId!))}>Sign out</button>}
					</>
				)}
			</div>
			{status.accounts.length > 0 && (
				<label className="flex items-center gap-3 text-xs">
					OpenAI connection
					<select aria-label="OpenAI authentication" className="rounded-sm border border-border bg-background p-1.5 text-foreground" disabled={busy || status.pending} value={status.mode} onChange={(e) => void run((b) => b.setMode(e.target.value as ChatGPTStatus["mode"]))}>
						<option value="chatgpt">ChatGPT subscription</option>
						<option value="api_key">API key (separate billing)</option>
					</select>
				</label>
			)}
			<p className="text-xs text-muted-foreground">Authorize use of your ChatGPT plan in your browser. Model selections stay as configured.</p>
			{(error || status.message) && <p role="alert" className="text-xs text-red-400">{error || status.message}</p>}
		</SettingsGroup>
	);
}
