const { Plugin, MarkdownView, Notice } = require('obsidian');
const { remote } = require('electron');
const { ViewPlugin, Decoration, WidgetType } = require('@codemirror/view');

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

class FatebookPlugin extends Plugin {
    async onload() {
        this.settings = {
            fatebookHost: 'fatebook.io',
            fatebookUrl: 'https://fatebook.io/',
            apiKey: 'oeslwryqqz9hs15tuzfsvs'
        };

        this.debouncedEnhanceMarkdownLinks = debounce(this.enhanceMarkdownLinks.bind(this), 60000);

        this.loginCallbacks = [];
        this.isLoggedIn = false;

        this.addCommand({
            id: 'open-fatebook-modal',
            name: 'Create Fatebook Prediction',
            hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "F" }],
            callback: () => this.openPredictionModal()
        });

        this.addRibbonIcon('scale', 'Fatebook', () => this.openPredictionModal());

        this.addWebviewStyles();

        this.registerEvent(this.app.workspace.on('file-open', this.onFileOpen.bind(this)));
        this.registerEvent(this.app.workspace.on('editor-change', this.onEditorChange.bind(this)));

        this.setupLogin();
    }

    async onunload() {
        this.predictWebview.remove();
        this.questionWebview.remove();
        this.style.remove();
    }

    async setupLogin() {
        await this.checkLoginStatus();
        if (!this.isLoggedIn) await this.openLoginModal();

        this.predictWebview = this.setupWebview('predict-modal');
        this.questionWebview = this.setupWebview('question-loader');

        window.addEventListener('message', this.handleIframeMessage.bind(this));

        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) {
            await this.enhanceMarkdownLinks(view);
        }
    }

    setupWebview(type) {
        const webview = document.createElement('iframe');
        Object.assign(webview, {
            className: 'fatebook-webview',
            src: `${this.settings.fatebookUrl}embed/${type}`,
            allowpopups: ''
        });
        document.body.appendChild(webview);
        return webview;
    }

    addWebviewStyles() {
        this.style = document.createElement('style');
        this.style.textContent = `
            .fatebook-webview {
                display: none;
                position: fixed;
                z-index: 1000;
                border: none;
                left: 50%;
                top: 50%;
                transform: translate(-50%, -50%);
                width: 75%;
                height: 75%;
            }
        `;
        document.head.appendChild(this.style);
    }

    handleIframeMessage({ data }) {
        console.log('Fatebook iframe message', data);
        if (!data?.isFatebook) return;
        const { action, embedId, ...rest } = data;
        
        switch (action) {
            case 'prediction_cancel':
                this.closePredictionModal();
                break;
            case 'prediction_create_success':
                this.handlePredictionCreated(rest.predictionLink);
                this.closePredictionModal();
                break;
            case 'load-url':
                const iframe = this.getWebviewByEmbedId(embedId);
                if (iframe) { iframe.src = rest.src; }
                break;
            // resize_iframe only gets sent for hover embed
                    // if (action === 'resize_iframe') {
                    //     console.log('Resizing iframe', iframe, 'to', rest.box);
                    //     iframe.style.width = `${rest.box.width}px`;
                    //     iframe.style.height = `${rest.box.height}px`;
            default:
                console.log(`Unhandled Fatebook action: ${action}`);
        }
    }

    getWebviewByEmbedId(embedId) {
        const webviews = {
            'predict-modal': this.predictWebview,
            'question-loader': this.questionWebview,
        };
        return webviews[embedId] || null;
    }

    openPredictionModal() {
        const selectedText = this.getSelectedText();
        this.predictWebview.style.display = 'block';
        this.sendMessageToWebview(this.predictWebview, 'focus_modal', { defaultText: selectedText });
        this.predictWebview.contentWindow.focus();
        this.setupCloseIframe(this.predictWebview);
    }


    getSelectedText() {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
            return activeView.editor.getSelection();
        }
        return '';
    }

    closePredictionModal() {
        console.log('Closing prediction modal');
        if (this.predictWebview) {
            this.predictWebview.style.display = 'none';
        } else {
            console.error('Prediction webview not found');
        }
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
            activeView.editor.focus();
        }
    }

    handlePredictionCreated(predictionLink) {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
            const editor = activeView.editor;
            const cursor = editor.getCursor();
            editor.replaceRange(`[](${predictionLink})`, cursor);
            this.enhanceMarkdownLinks(activeView);
        }
    }

    async enhanceFatebookLink(questionId) {
        try {
            const response = await fetch(`${this.settings.fatebookUrl}api/v0/getQuestion?questionId=${questionId}&apiKey=${this.settings.apiKey}`);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const { title, resolved, resolution, yourLatestPrediction } = await response.json();
            if (title) {
                let statusEmoji;
                if (resolved) {
                    if (resolution === 'YES') {
                        statusEmoji = '✅ ';
                    } else if (resolution === 'NO') {
                        statusEmoji = '❌ ';
                    } else {
                        statusEmoji = '🤷';
                    }
                } else {
                    statusEmoji = '⚖';
                }
                const predictionText = yourLatestPrediction !== undefined ? ` (You: ${(parseFloat(yourLatestPrediction) * 100).toFixed(0)}% yes)` : '';
                return `${statusEmoji} ${title}${predictionText}`;
            }
        } catch (error) {
            console.error('Error fetching Fatebook question details:', error);
        }
        return null;
    }

    getQuestionIdFromUrl(url) {
        const lastSegment = url.substring(url.lastIndexOf("/") + 1);
        const parts = lastSegment.match(/(.*)--(.*?)(?:\?|$|&)/);
        return parts ? parts[2] : lastSegment || "";
    }

    // unused
    async loadQuestion(questionId) {
        this.questionWebview.style.display = 'block';
        this.sendMessageToWebview(this.questionWebview, 'load_question', { questionId });
        this.setupCloseIframe(this.questionWebview);
    }

    setupCloseIframe(iframe) {
        // Add click event listener to close the webview when clicking outside
        const closeQuestionWebview = (event) => {
            if (!iframe.contains(event.target)) {
                iframe.style.display = 'none';
                document.removeEventListener('click', closeQuestionWebview);
            }
        };
        // Use setTimeout to add the event listener on the next tick
        // This prevents the webview from closing immediately when opened
        setTimeout(() => {
            document.addEventListener('click', closeQuestionWebview);
        }, 0);
    }

    sendMessageToWebview(webview, action, data = {}) {
        webview.contentWindow.postMessage({ isFatebook: true, action, ...data }, '*');
    }

    loadUrl(iframe, src) {
        const wasOpen = iframe.style.display === 'block';
        const parent = iframe.parentElement;
        iframe.remove();
        iframe.src = src;
        parent?.appendChild(iframe);
        if (wasOpen) {
            if (iframe === this.predictWebview) {
                this.openPredictionModal();
            } else if (iframe === this.questionWebview) {
                this.loadQuestion({ questionId: this.loadedQuestionId });
            }
        }
    }

    async checkLoginStatus() {
        try {
            const response = await remote.net.fetch(`${this.settings.fatebookUrl}api/auth/session`, {'credentials': 'include'});
            const data = await response.json();
            this.isLoggedIn = data.user !== undefined;
        } catch (error) {
            console.error('Error checking login status via Electron net module', error);
            this.isLoggedIn = false;
        }
    }

    async ensureLoggedIn() {
        if (!this.isLoggedIn) {
            return new Promise((resolve) => {
                this.loginCallbacks.push(resolve);
            });
        }
    }

    async openLoginModal() {
        const loginIframe = document.createElement('webview');
        loginIframe.src = 'https://fatebook.io/api/auth/signin';
        loginIframe.className = 'fatebook-webview';
        loginIframe.style.display = 'block';
        loginIframe.shadowRoot.querySelector('iframe').style.height = '100%';
        document.body.appendChild(loginIframe);

        // this.loginWebview.style.display = 'block';
        // this.loginWebview.style.width = '400px';
        // this.loginWebview.style.height = '1000px';

        return new Promise((resolve) => {
            const checkLoginInterval = setInterval(async () => {
                await this.checkLoginStatus();
                if (this.isLoggedIn) {
                    clearInterval(checkLoginInterval);
                    this.loginCallbacks.forEach((callback) => callback());
                    this.loginCallbacks = [];
                    loginIframe.remove();
                    new Notice('Login successful');
                    
                    resolve();
                }
            }, 1000);
        });
    }

    async enhanceMarkdownLinks(view) {
        await this.ensureLoggedIn();

        if (!view || !view.editor) return;
        const editor = view.editor;
        const file = view.file;
        let content = editor.getValue();
        const regex = /\[([^\]]*)\]\((https?:\/\/(?:www\.)?fatebook\.io\/q\/[^)]+)\)/g;
        
        let match;
        const changes = [];
        while ((match = regex.exec(content)) !== null) {
            const [fullMatch, linkText, url] = match;
            const questionId = this.getQuestionIdFromUrl(url);
            const enhancedText = await this.enhanceFatebookLink(questionId);
            
            if (enhancedText && enhancedText !== linkText) {
                changes.push({
                    from: fullMatch,
                    to: `[${enhancedText}](${url})`
                });
            }
        }

        if (view.editor === editor && view.file === file) {
            for (const change of changes) {
                let content = editor.getValue();
                const index = content.indexOf(change.from);
                if (index !== -1) {
                    const from = editor.offsetToPos(index);
                    const to = editor.offsetToPos(index + change.from.length);
                    editor.replaceRange(change.to, from, to);
                }
            }
        } else {
            console.log('Editor or file changed?');
        }

        // // Add click handlers to Fatebook links
        // this.addFatebookLinkHandlers(editor);
    }

    addFatebookLinkHandlers(editor) {
        return; // broken
        console.log('Adding Fatebook link handlers');
        const cmEditor = editor.cm;
        if (!cmEditor) {
            console.warn('CM Editor not found');
            return;
        }

        cmEditor.dom.addEventListener('mousedown', (event) => {
            const pos = cmEditor.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos) {
                const token = cmEditor.state.doc.lineAt(pos).text;
                const linkMatch = token.match(/\[([^\]]*)\]\((https?:\/\/(?:www\.)?fatebook\.io\/q\/[^)]+)\)/);
                
                if (linkMatch) {
                    const [, linkText, url] = linkMatch;
                    console.log('Fatebook link detected:', url);
                    event.preventDefault();
                    event.stopPropagation();
                    
                    const questionId = this.getQuestionIdFromUrl(url);
                    console.log('Loading question with ID:', questionId);
                    this.loadQuestion(questionId);
                }
            }
        }, true);
    }

    async onFileOpen(file) {
        if (file && file.extension === 'md') {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (view && view.file === file) {
                await this.enhanceMarkdownLinks(view);
            }
        }
    }

    async onEditorChange(editor, changeObj) {
        const view = editor.cm.view;
        this.debouncedEnhanceMarkdownLinks(view);
    }
}

module.exports = FatebookPlugin;
