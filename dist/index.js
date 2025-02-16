/******/ (() => { // webpackBootstrap
/******/ 	var __webpack_modules__ = ({

/***/ 974:
/***/ ((module) => {

module.exports = eval("require")("@actions/core");


/***/ }),

/***/ 858:
/***/ ((module) => {

module.exports = eval("require")("@actions/github");


/***/ }),

/***/ 896:
/***/ ((module) => {

"use strict";
module.exports = require("fs");

/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __nccwpck_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		var threw = true;
/******/ 		try {
/******/ 			__webpack_modules__[moduleId](module, module.exports, __nccwpck_require__);
/******/ 			threw = false;
/******/ 		} finally {
/******/ 			if(threw) delete __webpack_module_cache__[moduleId];
/******/ 		}
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/compat */
/******/ 	
/******/ 	if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = __dirname + "/";
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
const core = __nccwpck_require__(974);
const github = __nccwpck_require__(858);
const fs = __nccwpck_require__(896);

async function run() {
    try {
        const token = core.getInput('github_token');
        const octokit = github.getOctokit(token);
        const { context } = github;
        const pr = context.payload.pull_request;

        if (!pr) {
            core.setFailed('No pull request found.');
            return;
        }

        const files = await octokit.rest.pulls.listFiles({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: pr.number,
        });

        let comments = [];

        for (const file of files.data) {
            if (file.filename.endsWith('.js') || file.filename.endsWith('.py')) {
                const content = await fetchFileContent(file.raw_url);
                const suggestions = analyzeCode(content, file.filename);

                if (suggestions.length > 0) {
                    comments.push({
                        path: file.filename,
                        body: suggestions.join("\n"),
                        position: 1
                    });
                }
            }
        }

        if (comments.length > 0) {
            await octokit.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: pr.number,
                body: `### 🚀 Wasted Lines Detector Report\n\n${comments.map(c => `📌 **${c.path}**\n${c.body}`).join("\n\n")}`
            });
        }

    } catch (error) {
        core.setFailed(`Error: ${error.message}`);
    }
}

// Fetch file content from GitHub
async function fetchFileContent(url) {
    const response = await fetch(url);
    return await response.text();
}

// Analyze code for inefficiencies
function analyzeCode(content, filename) {
    let suggestions = [];

    // Check for unnecessary if-else statements
    const ifElsePattern = /\bif\s*\(.*\)\s*\{[^{}]*\}\s*else\s*\{[^{}]*\}/g;
    if (ifElsePattern.test(content)) {
        suggestions.push(`🔍 Found an unnecessary **if-else block**. Consider using a **ternary operator**.`);
    }

    // Check for duplicate variable assignments
    const duplicateVarPattern = /\b(let|const|var)\s+(\w+)\s*=.*;\s*\1\s+\2\s*=.*/g;
    if (duplicateVarPattern.test(content)) {
        suggestions.push(`🔍 Found **duplicate variable assignments**. Remove redundant lines.`);
    }

    // Detect overly complex loops
    const longLoopPattern = /\b(for|while)\s*\([^)]*\)\s*\{([^}]*\n){10,}/g;
    if (longLoopPattern.test(content)) {
        suggestions.push(`🔍 Found a **long loop** (> 10 lines). Consider refactoring into **smaller functions**.`);
    }

    return suggestions;
}

run();

module.exports = __webpack_exports__;
/******/ })()
;