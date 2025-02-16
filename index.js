const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs');

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
