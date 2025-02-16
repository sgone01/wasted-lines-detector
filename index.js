const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs');

async function run() {
    try {
        core.info("🚀 Wasted Lines Detector is starting...");

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

        // Fetch changed files in the PR
        const files = await octokit.rest.pulls.listFiles({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: pr.number,
        });

        let comments = [];
        let totalWastedLines = 0;

        core.info(`📂 Found ${files.data.length} changed files.`);

        for (const file of files.data) {
            core.info(`📄 Checking file: ${file.filename}`);

            if (file.filename.endsWith('.js') || file.filename.endsWith('.py')) {
                core.info(`🔍 Analyzing file: ${file.filename}`);
                
                const rawUrl = `https://raw.githubusercontent.com/${context.repo.owner}/${context.repo.repo}/${pr.head.ref}/${file.filename}`;
                const content = await fetchFileContent(rawUrl);
                if (!content) {
                    core.warning(`⚠️ Skipping ${file.filename} due to empty content.`);
                    continue;  // Skip analysis if file content is empty
                }
                core.info(`📜 File content preview:\n${content.substring(0, 500)}`);

                const suggestions = analyzeCode(content, file.filename);
                if (suggestions.length > 0) {
                    core.info(`💡 Suggestions found for ${file.filename}`);
                    totalWastedLines += suggestions.length;
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

        // Store the total number of wasted lines as output
        core.setOutput("wasted_lines", totalWastedLines);
        core.info(`📊 Total Wasted Lines Detected: ${totalWastedLines}`);

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
    try {
        core.info(`📥 Attempting to fetch file from: ${url}`);
        const response = await fetch(url);

        if (!response.ok) {
            core.warning(`⚠️ Failed to fetch content: ${response.status} ${response.statusText}`);
            return null;
        }

        const content = await response.text();
        core.info(`📜 First 300 characters of content:\n${content.substring(0, 300)}`);
        return content;
    } catch (error) {
        core.warning(`❌ Error fetching file: ${error.message}`);
        return null;
    }
}



// Analyze code for inefficiencies
function analyzeCode(content, filename) {
    let suggestions = [];
    core.info(`🔎 Running code analysis on ${filename}`);

    // 1️⃣ Detect Unnecessary If-Else Statements
    const ifElsePattern = /\bif\s*\(.*\)\s*\{[^{}]*\}\s*else\s*\{[^{}]*\}/g;
    if (ifElsePattern.test(content)) {
        core.info(`⚠️ Unnecessary if-else block detected.`);
        suggestions.push(`🔍 Found an unnecessary **if-else block**. Consider using a **ternary operator**.`);
    }

    // 2️⃣ Detect Duplicate Variable Assignments
    const duplicateVarPattern = /\b(let|const|var)\s+(\w+)\s*=\s*[^;]+;\s*\n\s*\1\s+\2\s*=/g;
    if (duplicateVarPattern.test(content)) {
        core.info(`⚠️ Duplicate variable assignments detected.`);
        suggestions.push(`🔍 Found **duplicate variable assignments**. Remove redundant lines.`);
    }

    // 3️⃣ Detect Overly Long Loops
    const longLoopPattern = /\b(for|while)\s*\([^)]*\)\s*\{([^}]*\n){10,}/g;
    if (longLoopPattern.test(content)) {
        core.info(`⚠️ Overly long loop detected.`);
        suggestions.push(`🔍 Found a **long loop** (> 10 lines). Consider refactoring into **smaller functions**.`);
    }

    // 4️⃣ Detect Console Logs (Optional)
    const consoleLogPattern = /console\.log\(/g;
    if ((content.match(consoleLogPattern) || []).length > 5) {
        core.info(`⚠️ Too many console logs detected.`);
        suggestions.push(`🔍 Found **too many console.log statements**. Consider removing unnecessary logs.`);
    }

    core.info(`📋 Total suggestions found: ${suggestions.length}`);
    return suggestions;
}


run();
