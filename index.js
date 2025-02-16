const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs');

async function run() {
    try {
        core.info("🚀 Wasted Lines Detector is starting...");

        // Debug: Log input token (Don't log actual secrets!)
        const token = core.getInput('github_token');
        if (!token) {
            core.setFailed("❌ Error: Missing GitHub Token!");
            return;
        }

        core.info("✅ GitHub Token received (hidden for security).");
        const octokit = github.getOctokit(token);
        const { context } = github;
        const pr = context.payload.pull_request;

        if (!pr) {
            core.setFailed('❌ No pull request found. Exiting.');
            return;
        }

        core.info(`🔍 PR Detected: #${pr.number} - Fetching changed files...`);

        // Fetch changed files in the pull request
        const files = await octokit.rest.pulls.listFiles({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: pr.number,
        });

        let comments = [];
        core.info(`📂 Found ${files.data.length} changed files.`);

        for (const file of files.data) {
            core.info(`📄 Checking file: ${file.filename}`);

            if (file.filename.endsWith('.js') || file.filename.endsWith('.py')) {
                core.info(`✅ Analyzing file: ${file.filename}`);

                const content = await fetchFileContent(file.raw_url);
                const suggestions = analyzeCode(content, file.filename);

                if (suggestions.length > 0) {
                    core.info(`💡 Suggestions found for ${file.filename}`);
                    comments.push({
                        path: file.filename,
                        body: suggestions.join("\n"),
                        position: 1
                    });
                } else {
                    core.info(`👍 No issues found in ${file.filename}`);
                }
            } else {
                core.info(`⏭ Skipping non-code file: ${file.filename}`);
            }
        }

        if (comments.length > 0) {
            core.info(`📝 Posting review comments on PR #${pr.number}...`);
            await octokit.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: pr.number,
                body: `### 🚀 Wasted Lines Detector Report\n\n${comments.map(c => `📌 **${c.path}**\n${c.body}`).join("\n\n")}`
            });
            core.info("✅ Review comments posted successfully.");
        } else {
            core.info("🎉 No issues detected. No comments added.");
        }

    } catch (error) {
        core.setFailed(`❌ Error: ${error.message}`);
    }
}

// Fetch file content from GitHub
async function fetchFileContent(url) {
    core.info(`📥 Fetching content from: ${url}`);
    const response = await fetch(url);
    const content = await response.text();
    core.info(`📜 Fetched ${content.length} characters.`);
    return content;
}

// Analyze code for inefficiencies
function analyzeCode(content, filename) {
    let suggestions = [];
    core.info(`🔎 Running code analysis on ${filename}`);

    // Check for unnecessary if-else statements
    const ifElsePattern = /\bif\s*\(.*\)\s*\{[^{}]*\}\s*else\s*\{[^{}]*\}/g;
    if (ifElsePattern.test(content)) {
        core.info(`⚠️ Unnecessary if-else block detected.`);
        suggestions.push(`🔍 Found an unnecessary **if-else block**. Consider using a **ternary operator**.`);
    }

    // Check for duplicate variable assignments
    const duplicateVarPattern = /\b(let|const|var)\s+(\w+)\s*=.*;\s*\1\s+\2\s*=.*/g;
    if (duplicateVarPattern.test(content)) {
        core.info(`⚠️ Duplicate variable assignments detected.`);
        suggestions.push(`🔍 Found **duplicate variable assignments**. Remove redundant lines.`);
    }

    // Detect overly complex loops
    const longLoopPattern = /\b(for|while)\s*\([^)]*\)\s*\{([^}]*\n){10,}/g;
    if (longLoopPattern.test(content)) {
        core.info(`⚠️ Overly long loop detected.`);
        suggestions.push(`🔍 Found a **long loop** (> 10 lines). Consider refactoring into **smaller functions**.`);
    }

    return suggestions;
}

run();
