document.addEventListener('DOMContentLoaded', () => {
    // Auth Elements
    const authContainer = document.getElementById('auth-container');
    const authTitle = document.getElementById('auth-title');
    const loginForm = document.getElementById('login-form');
    const signupForm = document.getElementById('signup-form');
    const twoFaSetup = document.getElementById('2fa-setup');
    const twoFaForm = document.getElementById('2fa-form');
    const authError = document.getElementById('auth-error');
    const qrCodeImg = document.getElementById('qr-code');

    // Video Overlay
    const videoOverlay = document.getElementById('video-overlay');
    const loginVideo = document.getElementById('login-video');

    // History Elements
    const historyBtn = document.getElementById('history-btn');
    const historyModal = document.getElementById('history-modal');
    const closeHistoryBtn = document.getElementById('close-history');
    const historyList = document.getElementById('history-list');

    // App Elements
    const appContainer = document.querySelector('.app-container');
    const chatForm = document.getElementById('chat-form');
    const userInput = document.getElementById('user-input');
    const chatHistory = document.getElementById('chat-history');
    const portalView = document.getElementById('portal-view');
    const chatView = document.getElementById('chat-view');
    const body = document.body;

    let isFirstMessage = true;
    let userId = null; // Store for 2FA verification
    let sessionToken = localStorage.getItem('chat_token');
    let isSignupFlow = false;

    // Generate unique session ID for this page load
    // Store in chatForm so it can be updated by history loader
    const initialSessionId = Date.now().toString(36) + Math.random().toString(36).substr(2);
    chatForm.dataset.currentSessionId = initialSessionId;
    console.log('New Session ID:', initialSessionId);

    // Check if already logged in
    if (sessionToken) {
        showApp();
    }

    // --- Auth Logic ---

    // Switch between Login and Signup
    document.getElementById('show-signup').addEventListener('click', (e) => {
        e.preventDefault();
        loginForm.classList.add('hidden');
        signupForm.classList.remove('hidden');
        authTitle.innerText = "Create Account";
        authError.innerText = "";
        authError.style.color = ""; // Reset color
    });

    document.getElementById('show-login').addEventListener('click', (e) => {
        e.preventDefault();
        signupForm.classList.add('hidden');
        loginForm.classList.remove('hidden');
        authTitle.innerText = "Jojo";
        authError.innerText = "";
        authError.style.color = ""; // Reset color
    });

    // Handle Logout
    document.getElementById('logout-btn').addEventListener('click', () => {
        localStorage.removeItem('chat_token');
        location.reload();
    });

    // Handle History
    historyBtn.addEventListener('click', async () => {
        historyModal.classList.remove('hidden');
        historyList.innerHTML = '<div class="history-placeholder">Loading sessions...</div>';

        try {
            const res = await fetch('/api/history', {
                headers: { 'Authorization': `Bearer ${sessionToken}` }
            });
            const data = await res.json();

            if (!res.ok) throw new Error(data.error);

            if (data.length === 0) {
                historyList.innerHTML = '<div class="history-placeholder">No saved chats found.</div>';
                return;
            }

            historyList.innerHTML = '';
            data.forEach(item => {
                const div = document.createElement('div');
                div.classList.add('history-item', 'session-item');
                div.dataset.sessionId = item.session_id;

                const time = new Date(item.timestamp).toLocaleString();

                // Handle Title
                let title = item.message;
                if (!item.session_id) {
                    title = "Archived Conversations";
                    div.classList.add('archived-session');
                } else {
                    // Truncate
                    title = item.message.length > 50 ? item.message.substring(0, 50) + '...' : item.message;
                }

                div.innerHTML = `
                    <div class="history-meta">
                        <span>${time}</span>
                    </div>
                    <div class="history-message">${title}</div>
                `;

                // Load Session on Click
                div.addEventListener('click', async () => {
                    const selectedSessionId = div.dataset.sessionId;
                    console.log('Loading Session ID:', selectedSessionId);
                    // alert('Debug: Loading Session ' + selectedSessionId); // Uncomment for user debugging if needed
                    await loadSession(selectedSessionId);
                    historyModal.classList.add('hidden');
                });

                historyList.appendChild(div);
            });

        } catch (error) {
            historyList.innerHTML = `<div class="history-placeholder error">Error: ${error.message}</div>`;
        }
    });

    // Helper to load a specific session
    async function loadSession(id) {
        // Update global sessionId (needs to be mutable, currently const in some scopes, see below)
        // We will just update the variable used in headers/body if we can, or reload.
        // Better: Update the 'sessionId' variable if it's let, otherwise we need to scope it properly.
        // Assuming current implementation defines 'sessionId' as const at top level, we might need to change it to let.

        // Actually, looking at previous edit, 'sessionId' was defined as const inside DOMContentLoaded. 
        // We need to change 'const sessionId' to 'window.currentSessionId' or a mutable variable.

        // For now, let's assume we change the variable definition in a separate edit if needed.
        // But to be safe, let's implement the fetching logic here.

        showLoadingOverlay(); // Standard loading

        try {
            const res = await fetch(`/api/session/${id}`, {
                headers: { 'Authorization': `Bearer ${sessionToken}` }
            });
            const messages = await res.json();

            if (!res.ok) throw new Error(messages.error);

            // Switch to Chat View
            switchToChatMode();

            chatHistory.innerHTML = '';

            // Update the global sessionId for FUTURE messages in this conversation
            // We need to ensure the main chat submit handler uses this new ID.
            // We'll store it in a data attribute on the body or form to share state.
            chatForm.dataset.currentSessionId = id;

            messages.forEach(msg => {
                addMessage(msg.message, msg.sender);
            });

            // Scroll to bottom
            setTimeout(() => {
                chatHistory.scrollTop = chatHistory.scrollHeight;
            }, 100);

        } catch (error) {
            console.error('Load Session Error:', error);
            alert('Failed to load session: ' + error.message);
        } finally {
            hideLoadingOverlay();
        }
    }

    function switchToChatMode() {
        console.log("Switching to Chat Mode...");
        isFirstMessage = false;

        // Remove class
        body.classList.remove('portal-mode');
        void body.offsetWidth; // Force Reflow/Repaint

        // Force Hide Portal
        portalView.classList.add('hidden');
        portalView.style.setProperty('display', 'none', 'important');

        // Force Show Chat
        chatView.classList.remove('hidden');
        chatView.style.display = 'flex';

        // Force Input Box to Bottom
        // We need to ensure .bottom-container loses the 'top: 50%' style if it was set via JS or sticky CSS
        const bottomContainer = document.querySelector('.bottom-container');
        if (bottomContainer) {
            bottomContainer.style.bottom = '20px'; // Reset to standard chat spacing
            bottomContainer.style.transform = 'none';
        }

        // Hide RSA Footer in Chat Mode
        const footer = document.querySelector('.site-footer');
        if (footer) footer.classList.add('hidden');

        // Ensure input is visible and ready
        if (userInput) userInput.focus();
    }

    function showLoadingOverlay() {
        // Simple overlay or reusable loader
        const overlay = document.createElement('div');
        overlay.id = 'session-loader';
        overlay.style.position = 'fixed';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.background = 'rgba(0,0,0,0.7)';
        overlay.style.display = 'flex';
        overlay.style.justifyContent = 'center';
        overlay.style.alignItems = 'center';
        overlay.style.zIndex = '5000';
        overlay.style.color = 'white';
        overlay.innerText = 'Loading Conversation...';
        document.body.appendChild(overlay);
    }

    function hideLoadingOverlay() {
        const overlay = document.getElementById('session-loader');
        if (overlay) overlay.remove();
    }

    closeHistoryBtn.addEventListener('click', () => {
        historyModal.classList.add('hidden');
    });

    // Close modal on outside click
    window.addEventListener('click', (e) => {
        if (e.target === historyModal) {
            historyModal.classList.add('hidden');
        }
    });

    // Handle Signup
    signupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const first_name = document.getElementById('signup-firstname').value;
        const last_name = document.getElementById('signup-lastname').value;
        const email = document.getElementById('signup-email').value;
        const password = document.getElementById('signup-password').value;

        try {
            const res = await fetch('/api/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ first_name, last_name, email, password })
            });
            const data = await res.json();

            if (!res.ok) throw new Error(data.error);

            // 2FA Disabled - Direct to Login
            authTitle.innerText = "Registration Success";
            authError.innerText = "Account created! Please login.";
            authError.style.color = "#a8c7fa"; // Success color style

            signupForm.classList.add('hidden');
            loginForm.classList.remove('hidden');

        } catch (err) {
            authError.innerText = err.message;
            authError.style.color = ""; // Reset to default error color
        }
    });

    // Handle Login
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-password').value;

        try {
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            const data = await res.json();

            if (!res.ok) throw new Error(data.error);

            // 2FA Disabled - Direct Login Success
            sessionToken = data.token;
            localStorage.setItem('chat_token', sessionToken);

            // Play Landing Animation
            playLoginAnimation();

        } catch (err) {
            authError.innerText = err.message;
        }
    });

    // Handle 2FA Verification
    twoFaForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const token = document.getElementById('2fa-code').value;

        try {
            const res = await fetch('/api/2fa/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, token })
            });
            const data = await res.json();

            if (!res.ok) throw new Error(data.error);

            // Success!
            // Success!
            if (isSignupFlow) {
                // Enforce Login
                authTitle.innerText = "Verification Success";
                authError.innerText = "Account verified! Please login now.";
                authError.style.color = "#a8c7fa"; // Success color style

                twoFaForm.classList.add('hidden');
                twoFaSetup.classList.add('hidden');
                loginForm.classList.remove('hidden');
            } else {
                sessionToken = data.token;
                localStorage.setItem('chat_token', sessionToken);

                // Play Landing Animation
                playLoginAnimation();
            }

        } catch (err) {
            authError.innerText = err.message;
        }
    });

    function playLoginAnimation() {
        console.log("Starting login animation...");
        authContainer.style.display = 'none';
        videoOverlay.classList.remove('hidden');

        // Safety timeout to ensure app loads even if video fails
        const safetyTimeout = setTimeout(() => {
            console.warn("Animation timed out, forcing app load.");
            finishLoginAnimation();
        }, 4000);

        const playPromise = loginVideo.play();

        if (playPromise !== undefined) {
            playPromise.then(() => {
                console.log("Video playing...");
            }).catch(e => {
                console.error("Auto-play failed:", e);
                clearTimeout(safetyTimeout);
                finishLoginAnimation();
            });
        }

        loginVideo.onended = () => {
            console.log("Video ended.");
            clearTimeout(safetyTimeout);
            finishLoginAnimation();
        };
    }

    function finishLoginAnimation() {
        console.log("Finishing animation...");
        videoOverlay.classList.add('fade-out');
        // Wait for fade out
        setTimeout(() => {
            videoOverlay.classList.add('hidden');
            showApp();
        }, 2000); // 2s matches css transition
    }

    function showApp() {
        console.log("Showing App Interface");
        authContainer.style.display = 'none';
        appContainer.classList.remove('hidden');

        // Set initial state
        body.classList.add('portal-mode');

        // Show Footer (in case coming from chat)
        const footer = document.querySelector('.site-footer');
        if (footer) footer.classList.remove('hidden');

        // Ensure input exists before focusing
        if (userInput) userInput.focus();
    }


    // --- App Logic ---

    // Suggestion chips (removed in previous steps but keeping listener safe if added back)

    // Auto-resize textarea
    userInput.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';

        // Reset if empty (handle backspace)
        if (this.value === '') {
            this.style.height = 'auto';
        }
    });

    // Handle Enter key in textarea
    userInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            chatForm.dispatchEvent(new Event('submit'));
        }
    });

    const fileInput = document.getElementById('file-input');
    const addFileBtn = document.getElementById('add-file-btn');
    const filePreviewContainer = document.getElementById('file-preview-container');
    let filesToUpload = [];

    // --- File Upload Logic ---

    addFileBtn.addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;

        files.forEach(file => {
            // Avoid duplicates
            if (!filesToUpload.some(f => f.name === file.name && f.size === file.size)) {
                filesToUpload.push(file);
            }
        });

        renderFilePreviews();
        fileInput.value = ''; // Reset so same file can be selected again if needed
    });

    function renderFilePreviews() {
        filePreviewContainer.innerHTML = '';
        filesToUpload.forEach((file, index) => {
            const item = document.createElement('div');
            item.classList.add('file-preview-item');

            const removeBtn = document.createElement('button');
            removeBtn.classList.add('file-remove-btn');
            removeBtn.innerHTML = '&times;';
            removeBtn.onclick = () => {
                filesToUpload.splice(index, 1);
                renderFilePreviews();
            };

            if (file.type.startsWith('image/')) {
                const img = document.createElement('img');
                img.classList.add('file-preview-img');
                img.file = file;
                item.appendChild(img);

                const reader = new FileReader();
                reader.onload = (e) => { img.src = e.target.result; };
                reader.readAsDataURL(file);
            } else {
                const icon = document.createElement('div');
                icon.classList.add('file-preview-icon');
                // Simple icon mapping based on extension could be added here
                icon.innerHTML = '📄';
                item.appendChild(icon);
            }

            item.appendChild(removeBtn);
            filePreviewContainer.appendChild(item);
        });
    }

    // Helper to read file as Base64 or Text
    const readFile = (file) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();

            // Text/Code files
            if (file.type.startsWith('text/') ||
                file.name.endsWith('.js') ||
                file.name.endsWith('.py') ||
                file.name.endsWith('.html') ||
                file.name.endsWith('.css') ||
                file.name.endsWith('.json') ||
                file.name.endsWith('.md')) {

                reader.onload = () => resolve({
                    name: file.name,
                    type: file.type || 'text/plain',
                    content: reader.result, // Text content
                    isText: true
                });
                reader.readAsText(file);
            }
            // Binary files (Images, PDF)
            else {
                reader.onload = () => {
                    const base64 = reader.result.split(',')[1];
                    resolve({
                        name: file.name,
                        type: file.type,
                        content: base64, // Base64 content
                        isText: false
                    });
                };
                reader.readAsDataURL(file);
            }
            reader.onerror = reject;
        });
    };

    chatForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const message = userInput.value.trim();

        if (!message && filesToUpload.length === 0) return;

        // Transition to Chat Mode on first message OR if UI is stuck
        if (isFirstMessage || body.classList.contains('portal-mode')) {
            switchToChatMode();
        }

        // Add user message
        let displayMessage = message;
        if (filesToUpload.length > 0) {
            displayMessage += ` <br><em>[Attached ${filesToUpload.length} file(s)]</em>`;
        }
        addMessage(displayMessage, 'user');

        userInput.value = '';
        userInput.style.height = 'auto'; // Reset height

        // Prepare payload with files
        const processedFiles = await Promise.all(filesToUpload.map(readFile));

        // Clear previews immediately after sending
        filesToUpload = [];
        renderFilePreviews();

        // Show loading and disable input
        const loadingId = showLoading();
        userInput.disabled = true;

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${sessionToken}`
                },
                body: JSON.stringify({ message, files: processedFiles, sessionId: chatForm.dataset.currentSessionId })
            });

            if (response.status === 401 || response.status === 403) {
                // Token invalid/expired
                localStorage.removeItem('chat_token');
                location.reload(); // Go back to login
                return;
            }

            if (!response.ok) {
                const errData = await response.text(); // Try to get text (handling non-json)
                let errMsg = 'Network response was not ok';
                try {
                    const jsonErr = JSON.parse(errData);
                    errMsg = jsonErr.error || errMsg;
                } catch (e) {
                    errMsg = errData || response.statusText;
                }
                throw new Error(errMsg);
            }
            const data = await response.json();

            removeLoading(loadingId);
            addMessage(data.reply, 'ai');

        } catch (error) {
            console.error('Error:', error);
            removeLoading(loadingId);
            addMessage(`Error: ${error.message}`, 'ai');
        } finally {
            // Re-enable input
            userInput.disabled = false;
            userInput.focus();
        }
    });

    function addMessage(text, sender) {
        const messageDiv = document.createElement('div');
        messageDiv.classList.add('message', sender);

        let contentHtml = '';

        if (sender === 'ai') {
            // Advanced Markdown Parsing
            const parts = text.split(/(```[\s\S]*?```)/g);
            const formattedText = parts.map(part => {
                if (part.startsWith('```') && part.endsWith('```')) {
                    // Extract content and optional language
                    let content = part.slice(3, -3);
                    let language = '';
                    const firstLineBreak = content.indexOf('\n');
                    if (firstLineBreak > -1) {
                        const firstLine = content.slice(0, firstLineBreak).trim();
                        // simplistic check: if first line is short and no spaces, assume language
                        if (firstLine && !firstLine.includes(' ')) {
                            language = firstLine;
                            content = content.slice(firstLineBreak + 1);
                        }
                    }
                    return `<pre><code class="${language}">${content}</code></pre>`;
                } else {
                    return part
                        .replace(/`([^`]+)`/g, '<code>$1</code>')
                        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
                        .replace(/^### (.*$)/gim, '<h3>$1</h3>')
                        .replace(/^## (.*$)/gim, '<h2>$1</h2>')
                        .replace(/^# (.*$)/gim, '<h1>$1</h1>')
                        .replace(/\n/g, '<br>');
                }
            }).join('');

            contentHtml = `
                <div class="icon-col"></div>
                <div class="content-col">${formattedText}</div>
            `;
        } else {
            contentHtml = `<div class="bubble">${text}</div>`;
        }

        messageDiv.innerHTML = contentHtml;
        chatHistory.appendChild(messageDiv);

        // Scroll to bottom of main content
        const mainContent = document.querySelector('.main-content');
        mainContent.scrollTo({
            top: mainContent.scrollHeight,
            behavior: 'smooth'
        });
    }

    function showLoading() {
        const id = 'loading-' + Date.now();
        const loadingDiv = document.createElement('div');
        loadingDiv.id = id;
        loadingDiv.classList.add('message', 'ai');
        loadingDiv.innerHTML = `
            <div class="icon-col"></div>
            <div class="content-col">
                <div class="typing-indicator">
                    <div class="typing-dot"></div>
                    <div class="typing-dot"></div>
                    <div class="typing-dot"></div>
                </div>
            </div>
        `;
        chatHistory.appendChild(loadingDiv);

        const mainContent = document.querySelector('.main-content');
        mainContent.scrollTo({
            top: mainContent.scrollHeight,
            behavior: 'smooth'
        });

        return id;
    }

    function removeLoading(id) {
        const element = document.getElementById(id);
        if (element) element.remove();
    }
});
