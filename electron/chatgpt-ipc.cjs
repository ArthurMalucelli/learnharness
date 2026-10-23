/** Two separate allowlists: renderer account controls; private child credentials. */
const { AuthError, USAGE_URL } = require("./chatgpt-auth.cjs");
const CHANNEL = "lh:chatgpt";
const publicError = (error) => error instanceof AuthError ? error.message : "ChatGPT connection failed. Try reconnecting in provider settings.";
function attachChatGPTChild(child, auth) {
	const send = (value) => { if (child.connected) child.send(value, () => {}); };
	const unsubscribe = auth.onChange((status) => send({ channel: CHANNEL, event: "status", status }));
	const listener = async (msg) => {
		if (!msg || msg.channel !== CHANNEL || typeof msg.id !== "string" || msg.id.length > 100) return;
		try {
			let value;
			if (msg.operation === "connection") value = await auth.connection();
			else if (msg.operation === "status") value = auth.status();
			else if (msg.operation === "models") value = await auth.models();
			else return;
			send({ channel: CHANNEL, id: msg.id, value });
		} catch (error) { send({ channel: CHANNEL, id: msg.id, error: publicError(error) }); }
	};
	child.on("message", listener);
	child.once("exit", () => { unsubscribe(); child.removeListener("message", listener); });
}
function installChatGPTRenderer({ ipcMain, BrowserWindow, shell, auth, origin }) {
	const operations = {
		status: () => auth.models(),
		signIn: (id) => auth.signIn(id),
		cancel: () => { auth.cancel(); return auth.status(); },
		select: (id) => auth.select(id),
		signOut: (id) => auth.signOut(id),
		setMode: (mode) => auth.setMode(mode),
		manageUsage: async () => { await shell.openExternal(USAGE_URL); return auth.status(); },
	};
	for (const [operation, handler] of Object.entries(operations)) {
		ipcMain.handle(`${CHANNEL}:${operation}`, async (event, value) => {
			const win = BrowserWindow.fromWebContents(event.sender);
			if (!win || event.senderFrame !== event.sender.mainFrame || new URL(event.senderFrame.url).origin !== origin) throw new Error("Untrusted ChatGPT account request.");
			if (value !== undefined && (typeof value !== "string" || value.length > 100)) throw new Error("Invalid ChatGPT account request.");
			try { return await handler(value); } catch (error) { throw new Error(publicError(error)); }
		});
	}
	auth.onChange((status) => {
		for (const win of BrowserWindow.getAllWindows()) {
			if (!win.isDestroyed() && new URL(win.webContents.getURL() || "about:blank").origin === origin) win.webContents.send(`${CHANNEL}:status`, status);
		}
	});
}
module.exports = { attachChatGPTChild, installChatGPTRenderer };
