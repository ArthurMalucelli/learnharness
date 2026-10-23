const { execFileSync } = require("node:child_process");
const path = require("node:path");
module.exports = async (context) => {
	await require("./after-pack.cjs")(context);
	if (context.electronPlatformName === "darwin") {
		const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
		// Documents/Finder metadata is not valid signed bundle content.
		execFileSync("/usr/bin/xattr", ["-cr", app]);
	}
};
