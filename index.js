const core = require('@actions/core');
const github = require('@actions/github');
const { createAppAuth } = require('@octokit/auth-app');
const { Octokit } = require('@octokit/rest');
const axios = require('axios');

async function getOctokitInstance() {
    try {
        const appId = process.env.GITHUB_APP_ID || core.getInput('github_app_id');
        const privateKey = process.env.GITHUB_PRIVATE_KEY || core.getInput('github_private_key');

        if (!appId || !privateKey) {
            throw new Error("❌ Missing GitHub App credentials.");
        }

        const auth = createAppAuth({ appId, privateKey });
        const appOctokit = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } });

        const { data: installations } = await appOctokit.rest.apps.listInstallations();
        if (!installations.length) throw new Error("❌ No installations found.");

        const installationId = installations[0].id;
        const installationAuth = await auth({ type: "installation", installationId });

        return new Octokit({ auth: installationAuth.token });
    } catch (error) {
        core.setFailed(`❌ Failed to authenticate GitHub App. Error: ${error.message}`);
    }
}

function getDiffPosition(patch, lineNumber) {
    if (!patch) return null;
    console.log(`🔍 Calculating diff position: Line ${lineNumber}, Patch:\n${patch}`);

    const lines = patch.split('\n');
    let diffPosition = 0;
    let currentLine = 0;

    for (const line of lines) {
        if (line.startsWith('@@')) {
            // Extract line numbers from the hunk header
            const match = line.match(/@@ -\d+,\d+ \+(\d+),(\d+) @@/);
            if (match) {
                currentLine = parseInt(match[1], 10);
            }
        } else if (!line.startsWith('-')) {
            // Only count added/unchanged lines
            diffPosition++;
            if (currentLine === lineNumber) {
                console.log(`✅ Found diff position: ${diffPosition} for line ${lineNumber}`);
                return diffPosition;
            }
            currentLine++;
        }
    }

    console.error(`❌ Could not determine diff position for line ${lineNumber}`);
    return null;
}

async function run() {
    try {
        const octokit = await getOctokitInstance();
        if (!octokit) return;

        const repo = github.context.repo;
        const prNumber = github.context.payload.pull_request?.number;
        const branch = github.context.payload.pull_request?.head?.ref;

        if (!prNumber || !branch) {
            core.setFailed("❌ PR number or branch not found.");
            return;
        }

        // Get the list of changed files
        const { data: files } = await octokit.rest.pulls.listFiles({
            owner: repo.owner,
            repo: repo.repo,
            pull_number: prNumber
        });

        if (!files.length) {
            console.log("No files changed in this PR.");
            return;
        }

        // Analyze files and generate comments
        const comments = await analyzeFiles(files, octokit, repo, branch);

        // Post review comments
        await postReviewComments(octokit, comments, repo, prNumber);
    } catch (error) {
        core.setFailed(`❌ Run failed: ${error.message}`);
    }
}

async function analyzeFiles(files, octokit, repo, branch) {
    let comments = [];

    for (const file of files) {
        if (!isSupportedFile(file.filename)) continue;

        const content = await fetchFileContent(octokit, repo.owner, repo.repo, file.filename, branch);
        if (!content) continue;

        const suggestion = await getSuggestionsFromGeminiAI(content, file.filename);
        if (!suggestion) continue;

        // Get the first non-empty line from the original content
        const firstLineNumber = content.split("\n").findIndex(line => line.trim() !== "") + 1;

        comments.push({
            path: file.filename,
            line: firstLineNumber, // Fix: Now we have a line number
            body: formatGitHubReviewComment(file.filename, content, suggestion)
        });
    }

    return comments;
}


async function fetchFileContent(octokit, owner, repo, path, ref) {
    const response = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    return Buffer.from(response.data.content, 'base64').toString('utf-8');
}

async function getSuggestionsFromGeminiAI(content, filename) {
    const language = getLanguageFromFilename(filename);
    const apiKey = process.env.AI_API_KEY || core.getInput('ai_api_key');
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const requestBody = {
        contents: [{
            parts: [{
                text: `Analyze this ${language} code. Provide:
1️⃣ Optimized version.
2️⃣ Time complexity.
3️⃣ Execution time.

Limit response to 10 words only.

Code:
\`\`\`${language.toLowerCase()}
${content}
\`\`\`
`
            }]
        }]
    };

    try {
        const response = await axios.post(apiUrl, requestBody, { headers: { 'Content-Type': 'application/json' } });
        return response.data?.candidates?.[0]?.content?.parts?.[0]?.text.trim() || null;
    } catch {
        return null;
    }
}

async function postReviewComments(octokit, comments, repo, prNumber) {
    if (!comments || comments.length === 0) {
        console.log("No comments to post.");
        return;
    }

    try {
        // Fetch the list of changed files in the PR
        const { data: pullRequestDiff } = await octokit.rest.pulls.listFiles({
            owner: repo.owner,
            repo: repo.repo,
            pull_number: prNumber
        });

        console.log("🔍 PR files:", pullRequestDiff.map(f => f.filename));

        const formattedComments = comments
            .map(comment => {
                if (!comment.path) {
                    console.error("❌ Comment path is missing:", comment);
                    return null;
                }

                const file = pullRequestDiff.find(f => f.filename === comment.path);
                if (!file) {
                    console.error(`❌ File ${comment.path} not found in PR.`);
                    return null;
                }

                // Ensure line number is set
                if (!comment.line) {
                    console.warn(`⚠️ No line number for ${comment.path}, setting default to 1`);
                    comment.line = 1; // Fallback to the first line
                }

                const position = getDiffPosition(file.patch, comment.line);
                if (position === null) {
                    console.error(`❌ Could not determine diff position for ${comment.path}:${comment.line}`);
                    return null;
                }

                return {
                    path: comment.path,
                    position,
                    body: `### 💡 Code Review for \`${comment.path}\`\n\n` +
                          `#### 📌 **Issue:**\n\`\`\`javascript\n${comment.originalCode}\n\`\`\`\n\n` +
                          `#### 🚀 **Suggested Fix:**\n\`\`\`javascript\n${comment.optimizedCode}\n\`\`\`\n\n` +
                          `🔹 **Complexity Analysis:** ${comment.complexity} \n\n` +
                          `_Generated by AI for better efficiency._`
                };
            })
            .filter(comment => comment !== null);

        if (formattedComments.length === 0) {
            console.log("⚠️ No valid review comments to post.");
            return;
        }

        await octokit.rest.pulls.createReview({
            owner: repo.owner,
            repo: repo.repo,
            pull_number: prNumber,
            event: "COMMENT",
            comments: formattedComments
        });

        console.log("✅ Review comments posted successfully.");
    } catch (error) {
        console.error("❌ Error posting review comments:", error);
    }
}



function formatGitHubReviewComment(filename, originalContent, suggestion) {
    return `### 💡 Code Review & Optimization for \`${filename}\`

---

#### **📌 Current Code**
\`\`\`${getLanguageFromFilename(filename).toLowerCase()}
${originalContent}
\`\`\`

#### **🚀 Optimized Code**
${suggestion}

---
🔹 **Complexity & Performance Analysis**  
_Generated by AI for better efficiency._
`;
}

function getLanguageFromFilename(filename) {
    if (filename.endsWith('.js')) return 'JavaScript';
    if (filename.endsWith('.py')) return 'Python';
    if (filename.endsWith('.sh')) return 'Shell';
    if (filename.endsWith('.rb')) return 'Ruby';
    if (filename.endsWith('.groovy')) return 'Groovy';
    return 'Unknown';
}

function isSupportedFile(filename) {
    return ['.js', '.py', '.sh', '.rb', '.groovy'].some(ext => filename.endsWith(ext));
}

run();
