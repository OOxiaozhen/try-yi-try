(function() {
    'use strict';

    // ============================================
    // 配置参数 - 可通过 AI.setWeights() 动态调整
    // ============================================
    const CONFIG = {
        MIN_SEARCH_DEPTH: 4,
        MAX_SEARCH_DEPTH: 6,
        SEARCH_TIMEOUT_MS: 50,
        MOVE_ORDER: ['left', 'up', 'down', 'right'],
        STUCK_THRESHOLD: 3,
        CYCLE_DETECTION_LENGTH: 20,
        DEFAULT_SPEED: 80,
        SPEED_OPTIONS: [10, 20, 50, 80, 100, 200, 500],
        WEIGHTS: {
            MONOTONICITY: 1.5,
            EMPTY_CELLS: 3.0,
            SMOOTHNESS: 0.8,
            POTENTIAL_MERGES: 2.0,
            CORNER_BONUS: 8.0,
            SNAKE_BONUS: 1.5,
            MAX_TILE_STABILITY: 4.0,
            FUTURE_MERGE: 1.2,
            LARGE_TILE_SEPARATION: -1.5,
            ISLANDS_PENALTY: -3.0,
            DEAD_PENALTY: -20000,
            LARGE_TILE_BONUS: 0.5
        },
        PHASE_WEIGHT_MULTIPLIERS: {
            early: { EMPTY_CELLS: 1.5, POTENTIAL_MERGES: 1.2 },
            middle: { MONOTONICITY: 1.3, SNAKE_BONUS: 1.2 },
            late: { CORNER_BONUS: 1.8, MAX_TILE_STABILITY: 1.5, ISLANDS_PENALTY: 1.5 },
            dead: { POTENTIAL_MERGES: 2.0, EMPTY_CELLS: 2.0, MONOTONICITY: 0.5 }
        }
    };

    let currentWeights = { ...CONFIG.WEIGHTS };
    let currentSpeed = CONFIG.DEFAULT_SPEED;

    // ============================================
    // 统计数据
    // ============================================
    const Stats = {
        reset() {
            this.moveCount = 0;
            this.totalNodesSearched = 0;
            this.totalSearchTime = 0;
            this.cacheHits = 0;
            this.cacheMisses = 0;
            this.searchTimes = [];
            this.nodesPerMove = [];
            this.lastFrameTime = Date.now();
            this.fps = 0;
        },
        get averageSearchTime() {
            if (this.searchTimes.length === 0) return 0;
            return this.totalSearchTime / this.searchTimes.length;
        },
        get averageNodes() {
            if (this.nodesPerMove.length === 0) return 0;
            return Math.round(this.totalNodesSearched / Math.max(1, this.nodesPerMove.length));
        },
        get cacheHitRate() {
            const total = this.cacheHits + this.cacheMisses;
            return total > 0 ? Math.round((this.cacheHits / total) * 100) : 0;
        }
    };

    // ============================================
    // Transposition Table (置换表缓存)
    // ============================================
    const TranspositionTable = {
        table: new Map(),
        maxSize: 50000,
        
        hash(board) {
            let hash = 0;
            for (let r = 0; r < 4; r++) {
                for (let c = 0; c < 4; c++) {
                    hash = ((hash << 5) - hash) + board[r][c];
                    hash = hash & hash;
                }
            }
            return hash;
        },
        
        get(board, depth, isPlayer) {
            const key = this.hash(board);
            const entry = this.table.get(key);
            if (entry && entry.depth >= depth && entry.isPlayer === isPlayer) {
                Stats.cacheHits++;
                return entry;
            }
            Stats.cacheMisses++;
            return null;
        },
        
        put(board, depth, isPlayer, score, direction) {
            if (this.table.size >= this.maxSize) {
                const firstKey = this.table.keys().next().value;
                this.table.delete(firstKey);
            }
            const key = this.hash(board);
            this.table.set(key, { depth, isPlayer, score, direction });
        },
        
        clear() {
            this.table.clear();
        },
        
        get size() {
            return this.table.size;
        }
    };

    // ============================================
    // GameReader - 游戏状态读取模块
    // ============================================
    const GameReader = {
        boardSize: 4,
        
        getBoard() {
            const board = Array(this.boardSize).fill(null).map(() => Array(this.boardSize).fill(0));
            const tiles = document.querySelectorAll('.tile, .tile-inner');
            
            if (tiles.length === 0) {
                return board;
            }
            
            const tileContainers = document.querySelectorAll('.tile');
            tileContainers.forEach(tile => {
                const classes = Array.from(tile.classList);
                const positionClass = classes.find(c => c.startsWith('tile-position-'));
                const valueClass = classes.find(c => /^tile-\d+$/.test(c) && !c.startsWith('tile-position-'));
                
                if (positionClass && valueClass) {
                    const posMatch = positionClass.match(/tile-position-(\d+)-(\d+)/);
                    const valMatch = valueClass.match(/tile-(\d+)/);
                    
                    if (posMatch && valMatch) {
                        const col = parseInt(posMatch[1]) - 1;
                        const row = parseInt(posMatch[2]) - 1;
                        const value = parseInt(valMatch[1]);
                        if (row >= 0 && row < this.boardSize && col >= 0 && col < this.boardSize) {
                            board[row][col] = Math.max(board[row][col], value);
                        }
                    }
                }
            });
            
            return board;
        },
        
        getScore() {
            const scoreContainer = document.querySelector('.score-container');
            if (scoreContainer) {
                const scoreText = scoreContainer.childNodes[0] ? scoreContainer.childNodes[0].textContent : scoreContainer.textContent;
                const scoreMatch = scoreText.match(/(\d+)/);
                return scoreMatch ? parseInt(scoreMatch[1]) : 0;
            }
            return 0;
        },
        
        isGameOver() {
            return document.querySelector('.game-over') !== null;
        },
        
        isVictory() {
            return document.querySelector('.game-won') !== null;
        },
        
        getContinueButton() {
            const buttons = document.querySelectorAll('.game-message a, .keep-playing-button');
            return Array.from(buttons).find(btn => 
                btn.textContent.includes('Continue') || 
                btn.textContent.includes('继续') ||
                btn.classList.contains('keep-playing-button')
            );
        },
        
        getRetryButton() {
            return document.querySelector('.retry-button') ||
                   Array.from(document.querySelectorAll('.game-message a, .restart-button')).find(btn => 
                       btn.textContent.includes('Try Again') || 
                       btn.textContent.includes('再来一次') || 
                       btn.textContent.includes('重试') ||
                       btn.classList.contains('restart-button')
                   );
        },
        
        clickContinue() {
            const btn = this.getContinueButton();
            if (btn) {
                btn.click();
                return true;
            }
            return false;
        },
        
        clickRetry() {
            const btn = this.getRetryButton();
            if (btn) {
                btn.click();
                return true;
            }
            return false;
        },
        
        getMaxTile(board) {
            let max = 0;
            for (let r = 0; r < this.boardSize; r++) {
                for (let c = 0; c < this.boardSize; c++) {
                    max = Math.max(max, board[r][c]);
                }
            }
            return max;
        },
        
        getEmptyCells(board) {
            const empty = [];
            for (let r = 0; r < this.boardSize; r++) {
                for (let c = 0; c < this.boardSize; c++) {
                    if (board[r][c] === 0) {
                        empty.push({row: r, col: c});
                    }
                }
            }
            return empty;
        },
        
        boardEquals(board1, board2) {
            for (let r = 0; r < this.boardSize; r++) {
                for (let c = 0; c < this.boardSize; c++) {
                    if (board1[r][c] !== board2[r][c]) return false;
                }
            }
            return true;
        },
        
        cloneBoard(board) {
            return board.map(row => [...row]);
        },
        
        waitForDOM(selector, timeout = 2000) {
            return new Promise((resolve) => {
                if (document.querySelector(selector)) {
                    resolve(true);
                    return;
                }
                const observer = new MutationObserver(() => {
                    if (document.querySelector(selector)) {
                        observer.disconnect();
                        resolve(true);
                    }
                });
                observer.observe(document.body, { childList: true, subtree: true });
                setTimeout(() => {
                    observer.disconnect();
                    resolve(false);
                }, timeout);
            });
        }
    };

    // ============================================
    // MoveSender - 按键发送模块
    // ============================================
    const MoveSender = {
        keyMap: {
            'up': { key: 'ArrowUp', code: 'ArrowUp', which: 38, keyCode: 38 },
            'down': { key: 'ArrowDown', code: 'ArrowDown', which: 40, keyCode: 40 },
            'left': { key: 'ArrowLeft', code: 'ArrowLeft', which: 37, keyCode: 37 },
            'right': { key: 'ArrowRight', code: 'ArrowRight', which: 39, keyCode: 39 }
        },
        
        async sendMove(direction) {
            return new Promise((resolve) => {
                const keyInfo = this.keyMap[direction];
                if (!keyInfo) {
                    resolve(false);
                    return;
                }
                
                const target = document.querySelector('.game-container') || window;
                const eventOptions = {
                    ...keyInfo,
                    bubbles: true,
                    cancelable: true
                };
                
                target.dispatchEvent(new KeyboardEvent('keydown', eventOptions));
                setTimeout(() => {
                    target.dispatchEvent(new KeyboardEvent('keyup', eventOptions));
                    setTimeout(resolve, currentSpeed, true);
                }, 10);
            });
        }
    };

    // ============================================
    // BoardOperations - 棋盘操作模块
    // ============================================
    const BoardOperations = {
        size: 4,
        
        moveLeft(board) {
            const newBoard = GameReader.cloneBoard(board);
            let moved = false;
            let score = 0;
            
            for (let r = 0; r < this.size; r++) {
                const row = newBoard[r].filter(val => val !== 0);
                const merged = [];
                let i = 0;
                
                while (i < row.length) {
                    if (i + 1 < row.length && row[i] === row[i + 1]) {
                        merged.push(row[i] * 2);
                        score += row[i] * 2;
                        i += 2;
                        moved = true;
                    } else {
                        merged.push(row[i]);
                        i++;
                    }
                }
                
                while (merged.length < this.size) merged.push(0);
                
                for (let c = 0; c < this.size; c++) {
                    if (newBoard[r][c] !== merged[c]) moved = true;
                    newBoard[r][c] = merged[c];
                }
            }
            
            return {board: newBoard, moved, score};
        },
        
        moveRight(board) {
            const reversed = board.map(row => [...row].reverse());
            const result = this.moveLeft(reversed);
            result.board = result.board.map(row => [...row].reverse());
            return result;
        },
        
        transpose(board) {
            const transposed = Array(this.size).fill(null).map(() => Array(this.size).fill(0));
            for (let r = 0; r < this.size; r++) {
                for (let c = 0; c < this.size; c++) {
                    transposed[c][r] = board[r][c];
                }
            }
            return transposed;
        },
        
        moveUp(board) {
            const transposed = this.transpose(board);
            const result = this.moveLeft(transposed);
            result.board = this.transpose(result.board);
            return result;
        },
        
        moveDown(board) {
            const transposed = this.transpose(board);
            const result = this.moveRight(transposed);
            result.board = this.transpose(result.board);
            return result;
        },
        
        move(board, direction) {
            switch(direction) {
                case 'left': return this.moveLeft(board);
                case 'right': return this.moveRight(board);
                case 'up': return this.moveUp(board);
                case 'down': return this.moveDown(board);
                default: return {board: GameReader.cloneBoard(board), moved: false, score: 0};
            }
        },
        
        getAvailableMoves(board) {
            const moves = [];
            for (const dir of CONFIG.MOVE_ORDER) {
                const result = this.move(board, dir);
                if (result.moved) {
                    moves.push({direction: dir, ...result});
                }
            }
            return moves;
        },
        
        addRandomTile(board) {
            const empty = GameReader.getEmptyCells(board);
            if (empty.length === 0) return board;
            const pos = empty[Math.floor(Math.random() * empty.length)];
            return this.addSpecificTile(board, pos.row, pos.col, Math.random() < 0.9 ? 2 : 4);
        },
        
        addSpecificTile(board, row, col, value) {
            const newBoard = GameReader.cloneBoard(board);
            newBoard[row][col] = value;
            return newBoard;
        }
    };

    // ============================================
    // GamePhaseDetector - 游戏阶段检测
    // ============================================
    const GamePhaseDetector = {
        detectPhase(board) {
            const emptyCount = GameReader.getEmptyCells(board).length;
            const maxTile = GameReader.getMaxTile(board);
            const availableMoves = BoardOperations.getAvailableMoves(board).length;
            
            if (availableMoves <= 1 || emptyCount <= 2) {
                return 'dead';
            } else if (maxTile >= 512 || emptyCount <= 5) {
                return 'late';
            } else if (maxTile >= 128 || emptyCount <= 8) {
                return 'middle';
            } else {
                return 'early';
            }
        },
        
        getAdjustedWeights(phase) {
            const multipliers = CONFIG.PHASE_WEIGHT_MULTIPLIERS[phase] || {};
            const adjusted = { ...currentWeights };
            for (const [key, mult] of Object.entries(multipliers)) {
                if (adjusted[key] !== undefined) {
                    adjusted[key] *= mult;
                }
            }
            return adjusted;
        }
    };

    // ============================================
    // BoardEvaluator - 多维度棋盘评分模块
    // ============================================
    const BoardEvaluator = {
        snakePatterns: [
            [[15,14,13,12],[8,9,10,11],[7,6,5,4],[0,1,2,3]],
            [[12,13,14,15],[11,10,9,8],[4,5,6,7],[3,2,1,0]],
            [[3,2,1,0],[4,5,6,7],[11,10,9,8],[12,13,14,15]],
            [[0,1,2,3],[7,6,5,4],[8,9,10,11],[15,14,13,12]],
            [[15,8,7,0],[14,9,6,1],[13,10,5,2],[12,11,4,3]],
            [[12,11,4,3],[13,10,5,2],[14,9,6,1],[15,8,7,0]],
            [[3,4,11,12],[2,5,10,13],[1,6,9,14],[0,7,8,15]],
            [[0,7,8,15],[1,6,9,14],[2,5,10,13],[3,4,11,12]]
        ],
        
        evaluateMonotonicity(board, weights) {
            let totals = [0, 0, 0, 0];
            
            for (let r = 0; r < 4; r++) {
                let current = 0, next = 1;
                while (next < 4) {
                    while (next < 4 && board[r][next] === 0) next++;
                    if (next >= 4) next--;
                    const cv = board[r][current] ? Math.log2(board[r][current]) : 0;
                    const nv = board[r][next] ? Math.log2(board[r][next]) : 0;
                    totals[0] += Math.min(0, nv - cv);
                    totals[1] += Math.min(0, cv - nv);
                    current = next++;
                }
            }
            
            for (let c = 0; c < 4; c++) {
                let current = 0, next = 1;
                while (next < 4) {
                    while (next < 4 && board[next][c] === 0) next++;
                    if (next >= 4) next--;
                    const cv = board[current][c] ? Math.log2(board[current][c]) : 0;
                    const nv = board[next][c] ? Math.log2(board[next][c]) : 0;
                    totals[2] += Math.min(0, nv - cv);
                    totals[3] += Math.min(0, cv - nv);
                    current = next++;
                }
            }
            
            return Math.max(totals[0], totals[1]) + Math.max(totals[2], totals[3]);
        },
        
        evaluateSmoothness(board, weights) {
            let smoothness = 0;
            for (let r = 0; r < 4; r++) {
                for (let c = 0; c < 4; c++) {
                    if (board[r][c]) {
                        const v = Math.log2(board[r][c]);
                        for (const [dr, dc] of [[0,1],[1,0]]) {
                            let nr = r + dr, nc = c + dc;
                            while (nr < 4 && nc < 4 && board[nr][nc] === 0) { nr += dr; nc += dc; }
                            if (nr < 4 && nc < 4 && board[nr][nc]) {
                                smoothness -= Math.abs(v - Math.log2(board[nr][nc]));
                            }
                        }
                    }
                }
            }
            return smoothness;
        },
        
        evaluateEmptyCells(board, weights) {
            return GameReader.getEmptyCells(board).length;
        },
        
        evaluatePotentialMerges(board, weights) {
            let merges = 0;
            for (let r = 0; r < 4; r++) {
                for (let c = 0; c < 4; c++) {
                    if (board[r][c]) {
                        if (c + 1 < 4 && board[r][c] === board[r][c+1]) merges++;
                        if (r + 1 < 4 && board[r][c] === board[r+1][c]) merges++;
                    }
                }
            }
            return merges;
        },
        
        evaluateCornerBonus(board, weights) {
            const max = GameReader.getMaxTile(board);
            const corners = [board[0][0], board[0][3], board[3][0], board[3][3]];
            let score = 0;
            if (corners.includes(max)) score += Math.log2(max);
            for (const corner of corners) {
                if (corner && corner >= max / 2) score += Math.log2(corner) * 0.5;
            }
            return score;
        },
        
        evaluateSnakeBonus(board, weights) {
            let best = -Infinity;
            for (const pattern of this.snakePatterns) {
                let score = 0;
                let gradient = true;
                for (let r = 0; r < 4; r++) {
                    for (let c = 0; c < 4; c++) {
                        if (board[r][c]) score += Math.log2(board[r][c]) * pattern[r][c];
                    }
                }
                best = Math.max(best, score);
            }
            return best / 15;
        },
        
        evaluateMaxTileStability(board, weights) {
            const max = GameReader.getMaxTile(board);
            const corners = [[0,0],[0,3],[3,0],[3,3]];
            for (const [cr, cc] of corners) {
                if (board[cr][cc] === max) {
                    let adjacent = 0;
                    let safe = true;
                    const dirs = cc === 0 ? [[0,1]] : [[0,-1]];
                    const vdirs = cr === 0 ? [[1,0]] : [[-1,0]];
                    for (const [dr, dc] of [...dirs, ...vdirs]) {
                        const nr = cr + dr, nc = cc + dc;
                        if (nr < 4 && nc < 4 && nr >= 0 && nc >= 0) {
                            adjacent++;
                            if (board[nr][nc] && board[nr][nc] > max / 4) safe = false;
                        }
                    }
                    return safe ? Math.log2(max) * adjacent : Math.log2(max) * 0.5;
                }
            }
            return 0;
        },
        
        evaluateFutureMerge(board, weights) {
            let score = 0;
            for (let r = 0; r < 4; r++) {
                for (let c = 0; c < 4; c++) {
                    if (board[r][c]) {
                        const v = Math.log2(board[r][c]);
                        for (const [dr, dc] of [[0,2],[2,0],[1,1],[-1,1],[1,-1],[-1,-1]]) {
                            const nr = r + dr, nc = c + dc;
                            if (nr >= 0 && nr < 4 && nc >= 0 && nc < 4 && board[nr][nc]) {
                                const nv = Math.log2(board[nr][nc]);
                                if (Math.abs(v - nv) <= 1) score += 0.5;
                            }
                        }
                    }
                }
            }
            return score;
        },
        
        evaluateLargeTileSeparation(board, weights) {
            const max = GameReader.getMaxTile(board);
            if (max < 256) return 0;
            const largeTiles = [];
            for (let r = 0; r < 4; r++) {
                for (let c = 0; c < 4; c++) {
                    if (board[r][c] >= max / 4) largeTiles.push({r, c, v: board[r][c]});
                }
            }
            let separation = 0;
            for (let i = 0; i < largeTiles.length; i++) {
                for (let j = i + 1; j < largeTiles.length; j++) {
                    const dist = Math.abs(largeTiles[i].r - largeTiles[j].r) + Math.abs(largeTiles[i].c - largeTiles[j].c);
                    const ratio = Math.min(largeTiles[i].v, largeTiles[j].v) / Math.max(largeTiles[i].v, largeTiles[j].v);
                    if (ratio >= 0.5) separation += dist * ratio;
                }
            }
            return -separation;
        },
        
        countIslands(board) {
            const visited = Array(4).fill(null).map(() => Array(4).fill(false));
            let islands = 0;
            
            const flood = (r, c, value, tolerance) => {
                if (r < 0 || r >= 4 || c < 0 || c >= 4 || visited[r][c]) return;
                if (!board[r][c]) return;
                const ratio = Math.min(value, board[r][c]) / Math.max(value, board[r][c]);
                if (ratio < tolerance) return;
                visited[r][c] = true;
                for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
                    flood(r + dr, c + dc, value, tolerance);
                }
            };
            
            for (let r = 0; r < 4; r++) {
                for (let c = 0; c < 4; c++) {
                    if (board[r][c] && !visited[r][c]) {
                        islands++;
                        flood(r, c, board[r][c], 0.25);
                    }
                }
            }
            return islands;
        },
        
        evaluateIslandsPenalty(board, weights) {
            return -this.countIslands(board);
        },
        
        isDead(board) {
            return BoardOperations.getAvailableMoves(board).length === 0;
        },
        
        evaluate(board, phase = 'middle') {
            if (this.isDead(board)) return currentWeights.DEAD_PENALTY;
            
            const weights = GamePhaseDetector.getAdjustedWeights(phase);
            
            return (
                this.evaluateMonotonicity(board, weights) * weights.MONOTONICITY +
                this.evaluateEmptyCells(board, weights) * weights.EMPTY_CELLS +
                this.evaluateSmoothness(board, weights) * weights.SMOOTHNESS +
                this.evaluatePotentialMerges(board, weights) * weights.POTENTIAL_MERGES +
                this.evaluateCornerBonus(board, weights) * weights.CORNER_BONUS +
                this.evaluateSnakeBonus(board, weights) * weights.SNAKE_BONUS +
                this.evaluateMaxTileStability(board, weights) * weights.MAX_TILE_STABILITY +
                this.evaluateFutureMerge(board, weights) * weights.FUTURE_MERGE +
                this.evaluateLargeTileSeparation(board, weights) * weights.LARGE_TILE_SEPARATION +
                this.evaluateIslandsPenalty(board, weights) * weights.ISLANDS_PENALTY +
                GameReader.getMaxTile(board) * weights.LARGE_TILE_BONUS
            );
        }
    };

    // ============================================
    // Expectimax Searcher - 带超时、缓存、剪枝
    // ============================================
    const Expectimax = {
        searchStartTime: 0,
        timeoutReached: false,
        nodesSearched: 0,
        currentBestMove: null,
        
        getSearchDepth(emptyCount) {
            if (emptyCount <= 2) return CONFIG.MAX_SEARCH_DEPTH;
            if (emptyCount <= 4) return 5;
            return CONFIG.MIN_SEARCH_DEPTH;
        },
        
        playerSearch(board, depth, alpha, beta, phase, checkPaused) {
            this.nodesSearched++;
            
            if (Date.now() - this.searchStartTime > CONFIG.SEARCH_TIMEOUT_MS) {
                this.timeoutReached = true;
            }
            
            if (checkPaused && checkPaused()) {
                this.timeoutReached = true;
            }
            
            const cached = TranspositionTable.get(board, depth, true);
            if (cached) return cached.score;
            
            const moves = BoardOperations.getAvailableMoves(board);
            
            if (moves.length === 0) {
                return currentWeights.DEAD_PENALTY;
            }
            
            if (depth === 0 || this.timeoutReached) {
                const score = BoardEvaluator.evaluate(board, phase);
                TranspositionTable.put(board, depth, true, score, null);
                return score;
            }
            
            if (moves.length === 1) {
                const result = this.chanceSearch(moves[0].board, depth - 1, alpha, beta, phase, checkPaused);
                TranspositionTable.put(board, depth, true, result, moves[0].direction);
                return result;
            }
            
            moves.sort((a, b) => {
                return BoardEvaluator.evaluate(b.board, phase) - BoardEvaluator.evaluate(a.board, phase);
            });
            
            let bestScore = -Infinity;
            let bestDir = moves[0].direction;
            
            for (const move of moves) {
                if (checkPaused && checkPaused()) {
                    this.timeoutReached = true;
                    break;
                }
                
                const score = this.chanceSearch(move.board, depth - 1, alpha, beta, phase, checkPaused);
                if (score > bestScore) {
                    bestScore = score;
                    bestDir = move.direction;
                }
                alpha = Math.max(alpha, bestScore);
                if (this.timeoutReached) break;
                if (beta <= alpha && depth > 2) break;
            }
            
            if (!this.timeoutReached) {
                TranspositionTable.put(board, depth, true, bestScore, bestDir);
            }
            
            if (depth === this.currentDepth) {
                this.currentBestMove = { direction: bestDir, score: bestScore };
            }
            
            return bestScore;
        },
        
        chanceSearch(board, depth, alpha, beta, phase, checkPaused) {
            this.nodesSearched++;
            
            if (Date.now() - this.searchStartTime > CONFIG.SEARCH_TIMEOUT_MS) {
                this.timeoutReached = true;
            }
            
            if (checkPaused && checkPaused()) {
                this.timeoutReached = true;
            }
            
            const cached = TranspositionTable.get(board, depth, false);
            if (cached) return cached.score;
            
            const emptyCells = GameReader.getEmptyCells(board);
            if (emptyCells.length === 0) {
                return BoardEvaluator.evaluate(board, phase);
            }
            
            if (depth === 0 || this.timeoutReached) {
                const score = BoardEvaluator.evaluate(board, phase);
                TranspositionTable.put(board, depth, false, score, null);
                return score;
            }
            
            const sampleLimit = depth <= 2 ? emptyCells.length : Math.min(8, emptyCells.length);
            const sampled = emptyCells.slice(0, sampleLimit);
            
            let totalScore = 0;
            let probabilitySum = 0;
            
            for (const cell of sampled) {
                for (const [value, prob] of [[2, 0.9], [4, 0.1]]) {
                    const newBoard = BoardOperations.addSpecificTile(board, cell.row, cell.col, value);
                    const score = this.playerSearch(newBoard, depth - 1, alpha, beta, phase, checkPaused);
                    totalScore += score * prob / sampled.length;
                    probabilitySum += prob / sampled.length;
                    if (this.timeoutReached) break;
                }
                if (this.timeoutReached) break;
            }
            
            const finalScore = totalScore / probabilitySum;
            if (!this.timeoutReached) {
                TranspositionTable.put(board, depth, false, finalScore, null);
            }
            return finalScore;
        },
        
        getBestMove(board, checkPaused = null) {
            this.searchStartTime = Date.now();
            this.timeoutReached = false;
            this.nodesSearched = 0;
            this.currentBestMove = null;
            
            const phase = GamePhaseDetector.detectPhase(board);
            const emptyCount = GameReader.getEmptyCells(board).length;
            const depth = this.getSearchDepth(emptyCount);
            this.currentDepth = depth;
            
            const moves = BoardOperations.getAvailableMoves(board);
            
            if (moves.length === 0) return null;
            if (moves.length === 1) {
                return {
                    direction: moves[0].direction,
                    score: BoardEvaluator.evaluate(moves[0].board, phase),
                    depth: 0,
                    nodes: 1,
                    time: 0,
                    phase,
                    timedOut: false
                };
            }
            
            if (checkPaused && checkPaused()) {
                return null;
            }
            
            let bestScore = -Infinity;
            let bestDir = moves[0].direction;
            let evalScores = {};
            
            moves.sort((a, b) => BoardEvaluator.evaluate(b.board, phase) - BoardEvaluator.evaluate(a.board, phase));
            
            for (const move of moves) {
                if (checkPaused && checkPaused()) {
                    break;
                }
                
                const score = this.chanceSearch(move.board, depth - 1, -Infinity, Infinity, phase, checkPaused);
                evalScores[move.direction] = score;
                if (score > bestScore) {
                    bestScore = score;
                    bestDir = move.direction;
                }
                if (this.timeoutReached) break;
            }
            
            const searchTime = Date.now() - this.searchStartTime;
            
            Stats.totalNodesSearched += this.nodesSearched;
            Stats.totalSearchTime += searchTime;
            Stats.searchTimes.push(searchTime);
            Stats.nodesPerMove.push(this.nodesSearched);
            if (Stats.searchTimes.length > 100) {
                Stats.totalNodesSearched -= Stats.nodesPerMove.shift();
                Stats.totalSearchTime -= Stats.searchTimes.shift();
            }
            
            return {
                direction: bestDir,
                score: bestScore,
                depth: depth,
                nodes: this.nodesSearched,
                time: searchTime,
                phase,
                evalScores,
                timedOut: this.timeoutReached
            };
        }
    };

    // ============================================
    // CycleDetector - 循环检测
    // ============================================
    const CycleDetector = {
        history: [],
        
        add(board) {
            const hash = TranspositionTable.hash(board);
            this.history.push(hash);
            if (this.history.length > CONFIG.CYCLE_DETECTION_LENGTH) {
                this.history.shift();
            }
        },
        
        isCycle() {
            if (this.history.length < 4) return false;
            const len = this.history.length;
            for (let cycleLen = 2; cycleLen <= 6; cycleLen++) {
                let isCycle = true;
                for (let i = 0; i < cycleLen; i++) {
                    if (this.history[len - 1 - i] !== this.history[len - 1 - i - cycleLen]) {
                        isCycle = false;
                        break;
                    }
                }
                if (isCycle) return true;
            }
            return false;
        },
        
        clear() {
            this.history = [];
        },
        
        getAlternativeMove(board, preferredDir) {
            const moves = BoardOperations.getAvailableMoves(board);
            const filtered = moves.filter(m => m.direction !== preferredDir);
            if (filtered.length > 0) {
                filtered.sort((a, b) => 
                    BoardEvaluator.evaluate(b.board) - BoardEvaluator.evaluate(a.board)
                );
                return filtered[0];
            }
            return moves[0];
        }
    };

    // ============================================
    // ControlPanel + Debug Overlay - 完整控制面板
    // ============================================
    const ControlPanel = {
        panel: null,
        state: 'paused',
        
        init(callbacks) {
            this.callbacks = callbacks;
            this.createPanel();
            this.bindEvents();
        },
        
        createPanel() {
            if (this.panel) this.panel.remove();
            
            this.panel = document.createElement('div');
            this.panel.id = 'ai2048-control-panel';
            this.panel.style.cssText = `
                position: fixed; top: 10px; right: 10px;
                background: rgba(250, 248, 239, 0.98); border: 3px solid #bbada0;
                border-radius: 10px; padding: 15px; z-index: 99999;
                font-family: "Clear Sans", "Helvetica Neue", Arial, sans-serif;
                font-size: 13px; min-width: 240px; max-width: 280px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.3); user-select: none;
            `;
            
            const speedOptions = CONFIG.SPEED_OPTIONS.map(s => 
                `<option value="${s}" ${s === currentSpeed ? 'selected' : ''}}>${s}ms</option>`
            ).join('');
            
            this.panel.innerHTML = `
                <div id="ai2048-header" style="font-weight: bold; font-size: 16px; margin-bottom: 12px; color: #776e65; text-align: center; cursor: move; padding: 5px; background: rgba(187,173,160,0.2); border-radius: 5px;">
                    🤖 2048 AI Controller
                </div>
                
                <div style="margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
                    <span style="color: #776e65; font-weight: bold;">状态:</span>
                    <span id="ai2048-status" style="font-weight: bold; color: #e74c3c; font-size: 14px;">Paused</span>
                </div>
                
                <div style="background: rgba(187,173,160,0.15); padding: 10px; border-radius: 6px; margin-bottom: 10px;">
                    <div style="font-weight: bold; color: #776e65; margin-bottom: 6px; font-size: 12px;">📊 游戏数据</div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px; font-size: 12px;">
                        <span style="color: #776e65;">分数:</span><span id="ai2048-score" style="font-weight: bold; color: #f67c5f;">0</span>
                        <span style="color: #776e65;">最高块:</span><span id="ai2048-max-tile" style="font-weight: bold; color: #f67c5f;">0</span>
                        <span style="color: #776e65;">移动次数:</span><span id="ai2048-moves" style="font-weight: bold; color: #776e65;">0</span>
                        <span style="color: #776e65;">游戏阶段:</span><span id="ai2048-phase" style="font-weight: bold; color: #8f7a66;">Early</span>
                    </div>
                </div>
                
                <div style="background: rgba(52,152,219,0.1); padding: 10px; border-radius: 6px; margin-bottom: 10px;">
                    <div style="font-weight: bold; color: #2980b9; margin-bottom: 6px; font-size: 12px;">🔍 搜索统计</div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px; font-size: 11px;">
                        <span style="color: #776e65;">选择方向:</span><span id="ai2048-chosen-move" style="font-weight: bold; color: #27ae60;">-</span>
                        <span style="color: #776e65;">评估分数:</span><span id="ai2048-evaluation" style="font-weight: bold; color: #776e65;">0</span>
                        <span style="color: #776e65;">搜索深度:</span><span id="ai2048-depth" style="font-weight: bold; color: #776e65;">0</span>
                        <span style="color: #776e65;">搜索节点:</span><span id="ai2048-nodes" style="font-weight: bold; color: #776e65;">0</span>
                        <span style="color: #776e65;">搜索耗时:</span><span id="ai2048-search-time" style="font-weight: bold; color: #776e65;">0ms</span>
                        <span style="color: #776e65;">平均耗时:</span><span id="ai2048-avg-time" style="font-weight: bold; color: #776e65;">0ms</span>
                        <span style="color: #776e65;">缓存命中:</span><span id="ai2048-cache-hit" style="font-weight: bold; color: #27ae60;">0%</span>
                        <span style="color: #776e65;">缓存大小:</span><span id="ai2048-cache-size" style="font-weight: bold; color: #776e65;">0</span>
                        <span style="color: #776e65;">FPS:</span><span id="ai2048-fps" style="font-weight: bold; color: #776e65;">0</span>
                    </div>
                    <div id="ai2048-thinking" style="color: #e74c3c; font-weight: bold; text-align: center; margin-top: 5px; display: none;">
                        🤔 Thinking...
                    </div>
                </div>
                
                <div style="margin-bottom: 10px;">
                    <div style="color: #776e65; margin-bottom: 4px; font-size: 12px; font-weight: bold;">⏱️ 移动速度</div>
                    <select id="ai2048-speed" style="width: 100%; padding: 6px; border: 1px solid #bbada0; border-radius: 4px; background: white; color: #776e65;">
                        ${speedOptions}
                    </select>
                </div>
                
                <div style="margin-bottom: 10px;">
                    <div style="color: #776e65; margin-bottom: 4px; font-size: 12px; font-weight: bold;">⏱️ 运行时间</div>
                    <div id="ai2048-runtime" style="font-weight: bold; text-align: center; color: #776e65; background: rgba(187,173,160,0.1); padding: 5px; border-radius: 4px;">
                        00:00:00
                    </div>
                </div>
                
                <div style="display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 5px;">
                    <button id="ai2048-pause" style="flex: 1; min-width: 70px; padding: 8px 5px; background: #e74c3c; color: white; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; font-size: 12px;">
                        ⏸️ 暂停
                    </button>
                    <button id="ai2048-resume" style="flex: 1; min-width: 70px; padding: 8px 5px; background: #27ae60; color: white; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; font-size: 12px;" disabled>
                        ▶️ 继续
                    </button>
                </div>
                <div style="display: flex; gap: 5px;">
                    <button id="ai2048-new-game" style="flex: 1; padding: 8px 5px; background: #3498db; color: white; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; font-size: 12px;">
                        🔄 新游戏
                    </button>
                    <button id="ai2048-stop" style="flex: 1; padding: 8px 5px; background: #7f8c8d; color: white; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; font-size: 12px;">
                        ⏹️ 停止
                    </button>
                </div>
            `;
            
            document.body.appendChild(this.panel);
            this.makeDraggable(this.panel, document.getElementById('ai2048-header'));
        },
        
        makeDraggable(el, handle) {
            let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
            handle.onmousedown = (e) => {
                e.preventDefault();
                pos3 = e.clientX; pos4 = e.clientY;
                document.onmouseup = () => { document.onmouseup = null; document.onmousemove = null; };
                document.onmousemove = (e) => {
                    e.preventDefault();
                    pos1 = pos3 - e.clientX; pos2 = pos4 - e.clientY;
                    pos3 = e.clientX; pos4 = e.clientY;
                    el.style.top = (el.offsetTop - pos2) + "px";
                    el.style.right = "auto";
                    el.style.left = (el.offsetLeft - pos1) + "px";
                };
            };
        },
        
        bindEvents() {
            document.getElementById('ai2048-pause').onclick = () => this.callbacks.onPause();
            document.getElementById('ai2048-resume').onclick = () => this.callbacks.onResume();
            document.getElementById('ai2048-stop').onclick = () => this.callbacks.onStop();
            document.getElementById('ai2048-new-game').onclick = () => this.callbacks.onNewGame();
            document.getElementById('ai2048-speed').onchange = (e) => {
                currentSpeed = parseInt(e.target.value);
                Logger.info(`速度设置为 ${currentSpeed}ms`);
            };
        },
        
        setState(state) {
            this.state = state;
            const statusEl = document.getElementById('ai2048-status');
            const pauseBtn = document.getElementById('ai2048-pause');
            const resumeBtn = document.getElementById('ai2048-resume');
            
            const states = {
                running: { text: 'Running', color: '#27ae60' },
                paused: { text: 'Paused', color: '#e74c3c' },
                stopped: { text: 'Stopped', color: '#7f8c8d' },
                thinking: { text: 'Thinking', color: '#f39c12' }
            };
            
            const s = states[state];
            statusEl.textContent = s.text;
            statusEl.style.color = s.color;
            
            pauseBtn.disabled = state === 'paused' || state === 'stopped';
            resumeBtn.disabled = state !== 'paused';
            pauseBtn.style.opacity = pauseBtn.disabled ? '0.5' : '1';
            resumeBtn.style.opacity = resumeBtn.disabled ? '0.5' : '1';
            
            document.getElementById('ai2048-thinking').style.display = state === 'thinking' ? 'block' : 'none';
        },
        
        updateStats(stats) {
            const update = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
            
            if (stats.score !== undefined) update('ai2048-score', stats.score);
            if (stats.maxTile !== undefined) update('ai2048-max-tile', stats.maxTile);
            if (stats.moves !== undefined) update('ai2048-moves', stats.moves);
            if (stats.phase !== undefined) {
                const phaseNames = { early: 'Early', middle: 'Middle', late: 'Late', dead: 'Dead!' };
                const phaseColors = { early: '#27ae60', middle: '#f39c12', late: '#e67e22', dead: '#e74c3c' };
                const el = document.getElementById('ai2048-phase');
                el.textContent = phaseNames[stats.phase];
                el.style.color = phaseColors[stats.phase];
            }
            if (stats.chosenMove !== undefined) update('ai2048-chosen-move', stats.chosenMove);
            if (stats.evaluation !== undefined) update('ai2048-evaluation', Math.round(stats.evaluation));
            if (stats.depth !== undefined) update('ai2048-depth', stats.depth);
            if (stats.nodes !== undefined) update('ai2048-nodes', stats.nodes);
            if (stats.searchTime !== undefined) update('ai2048-search-time', stats.searchTime + 'ms');
            if (stats.avgTime !== undefined) update('ai2048-avg-time', Math.round(stats.avgTime) + 'ms');
            if (stats.cacheHitRate !== undefined) {
                update('ai2048-cache-hit', stats.cacheHitRate + '%');
                const el = document.getElementById('ai2048-cache-hit');
                el.style.color = stats.cacheHitRate > 50 ? '#27ae60' : stats.cacheHitRate > 20 ? '#f39c12' : '#776e65';
            }
            if (stats.cacheSize !== undefined) update('ai2048-cache-size', stats.cacheSize);
            if (stats.fps !== undefined) update('ai2048-fps', stats.fps);
        },
        
        updateRuntime(runtime) {
            const el = document.getElementById('ai2048-runtime');
            if (el) el.textContent = runtime;
        },
        
        destroy() {
            if (this.panel) { this.panel.remove(); this.panel = null; }
        }
    };

    // ============================================
    // Logger - 增强日志
    // ============================================
    const Logger = {
        log(move, score, maxTile, evaluation, depth, nodes, time, phase, moveCount) {
            console.log(
                `%c[2048 AI]%c ${move.padEnd(5)} | Score: ${String(score).padStart(5)} | Max: ${String(maxTile).padStart(4)} | Eval: ${String(Math.round(evaluation)).padStart(6)} | D${depth} N${nodes} ${time}ms | Phase: ${phase.padEnd(6)} | Moves: ${moveCount}`,
                'color: #8f7a66; font-weight: bold;', 'color: #776e65;'
            );
        },
        error(msg) { console.error(`%c[2048 AI Error]%c ${msg}`, 'color: #e74c3c; font-weight: bold;', 'color: #c0392b;'); },
        info(msg) { console.log(`%c[2048 AI Info]%c ${msg}`, 'color: #3498db; font-weight: bold;', 'color: #2980b9;'); },
        warn(msg) { console.warn(`%c[2048 AI Warn]%c ${msg}`, 'color: #f39c12; font-weight: bold;', 'color: #d68910;'); }
    };

    // ============================================
    // DOM Recovery - 自动恢复机制
    // ============================================
    const DOMRecovery = {
        observer: null,
        startWatching(onGameReload) {
            this.stopWatching();
            this.observer = new MutationObserver((mutations) => {
                const gameContainer = document.querySelector('.game-container');
                if (!gameContainer && this.onGameReload) {
                    Logger.warn('游戏容器丢失，等待恢复...');
                    setTimeout(() => {
                        if (document.querySelector('.game-container')) {
                            Logger.info('游戏容器已恢复');
                            this.onGameReload();
                        }
                    }, 1000);
                }
            });
            this.observer.observe(document.body, { childList: true, subtree: true });
            this.onGameReload = onGameReload;
        },
        stopWatching() {
            if (this.observer) { this.observer.disconnect(); this.observer = null; }
        }
    };

    // ============================================
    // AutoPlayer - 核心控制器
    // ============================================
    const AutoPlayer = {
        isRunning: false,
        isPaused: false,
        shouldStop: false,
        waitForNewGame: false,
        moveCount: 0,
        lastBoard: null,
        stuckCount: 0,
        lastScore: 0,
        startTime: null,
        runtimeInterval: null,
        currentMoveResult: null,
        
        init() {
            this.reset();
            Stats.reset();
            TranspositionTable.clear();
            CycleDetector.clear();
            
            ControlPanel.init({
                onPause: () => this.pause(),
                onResume: () => this.resume(),
                onStop: () => this.stop(),
                onNewGame: () => this.newGame()
            });
            
            DOMRecovery.startWatching(() => this.handleGameReload());
            
            window.AI = {
                setWeights: (w) => { currentWeights = { ...currentWeights, ...w }; Logger.info('权重已更新'); },
                setSpeed: (ms) => { currentSpeed = ms; Logger.info(`速度设置为 ${ms}ms`); },
                getWeights: () => ({ ...currentWeights }),
                getStats: () => ({ ...Stats }),
                clearCache: () => { TranspositionTable.clear(); Logger.info('缓存已清空'); }
            };
            
            Logger.info('AI 已初始化，点击"继续"开始运行');
            Logger.info('使用 window.AI.setWeights() 可调整权重，window.AI.setSpeed() 调整速度');
        },
        
        reset() {
            this.moveCount = 0;
            this.lastBoard = null;
            this.stuckCount = 0;
            this.lastScore = 0;
            this.startTime = Date.now();
            this.currentMoveResult = null;
        },
        
        start() {
            if (this.isRunning && !this.isPaused) return;
            this.isRunning = true;
            this.isPaused = false;
            this.shouldStop = false;
            this.waitForNewGame = false;
            this.startTime = Date.now();
            this.startRuntimeTimer();
            ControlPanel.setState('running');
            this.gameLoop();
            Logger.info('AI 开始运行');
        },
        
        pause() {
            this.isPaused = true;
            ControlPanel.setState('paused');
            this.stopRuntimeTimer();
            Logger.info('AI 已暂停');
            this.setupNewGameDetection();
        },
        
        newGameDetectionSetup: false,
        
        setupNewGameDetection() {
            if (this.newGameDetectionSetup) return;
            
            const checkAndStart = () => {
                if (!this.isPaused || this.shouldStop) {
                    this.cleanupNewGameDetection();
                    return;
                }
                
                const board = GameReader.getBoard();
                const tileCount = board.flat().filter(c => c > 0).length;
                const gameOverElement = document.querySelector('.game-over');
                
                if (tileCount >= 2 && !gameOverElement) {
                    Logger.info('🎮 检测到新游戏开始，自动恢复运行！');
                    this.cleanupNewGameDetection();
                    this.reset();
                    this.isRunning = true;
                    this.isPaused = false;
                    this.startTime = Date.now();
                    this.startRuntimeTimer();
                    ControlPanel.setState('running');
                    this.gameLoop();
                }
            };
            
            this.newGameInterval = setInterval(checkAndStart, 300);
            
            const clickHandler = (e) => {
                const target = e.target;
                const isRetryBtn = target.closest('.retry-button, .restart-button') ||
                                  target.closest('a')?.textContent?.includes('Again') ||
                                  target.closest('a')?.textContent?.includes('再来') ||
                                  target.closest('a')?.textContent?.includes('New');
                if (isRetryBtn && this.isPaused) {
                    Logger.info('🔘 检测到新游戏按钮点击');
                    setTimeout(checkAndStart, 200);
                }
            };
            
            document.addEventListener('click', clickHandler);
            this.newGameClickHandler = clickHandler;
            this.newGameDetectionSetup = true;
        },
        
        cleanupNewGameDetection() {
            if (this.newGameInterval) {
                clearInterval(this.newGameInterval);
                this.newGameInterval = null;
            }
            if (this.newGameClickHandler) {
                document.removeEventListener('click', this.newGameClickHandler);
                this.newGameClickHandler = null;
            }
            this.newGameDetectionSetup = false;
        },
        
        resume() {
            this.isPaused = false;
            this.startTime = this.startTime || Date.now();
            this.startRuntimeTimer();
            ControlPanel.setState('running');
            Logger.info('AI 继续运行');
            this.gameLoop();
        },
        
        stop() {
            this.shouldStop = true;
            this.isRunning = false;
            this.isPaused = false;
            this.waitForNewGame = false;
            this.stopRuntimeTimer();
            this.cleanupNewGameDetection();
            DOMRecovery.stopWatching();
            ControlPanel.setState('stopped');
            Logger.info('AI 已停止');
            TranspositionTable.clear();
        },
        
        newGame() {
            const retryBtn = GameReader.getRetryButton();
            const restartBtn = document.querySelector('.restart-button') || 
                             document.querySelector('.game-message .retry-button') ||
                             Array.from(document.querySelectorAll('a')).find(a => a.textContent.includes('重新开始') || a.textContent.includes('New Game'));
            
            if (retryBtn) {
                retryBtn.click();
            } else if (restartBtn) {
                restartBtn.click();
            } else {
                Logger.warn('未找到新游戏按钮，请手动点击');
                return;
            }
            
            this.reset();
            Stats.reset();
            TranspositionTable.clear();
            CycleDetector.clear();
            
            if (this.isPaused) {
                this.waitForNewGame = true;
            } else {
                this.isRunning = true;
                this.isPaused = false;
                setTimeout(() => this.gameLoop(), 500);
            }
        },
        
        handleGameReload() {
            Logger.info('检测到游戏重新加载，重新初始化...');
            setTimeout(() => this.gameLoop(), 1000);
        },
        
        startRuntimeTimer() {
            this.stopRuntimeTimer();
            this.runtimeInterval = setInterval(() => {
                const elapsed = Math.floor((Date.now() - (this.startTime || Date.now())) / 1000);
                const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
                const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
                const s = String(elapsed % 60).padStart(2, '0');
                ControlPanel.updateRuntime(`${h}:${m}:${s}`);
                
                const now = Date.now();
                Stats.fps = Math.round(1000 / Math.max(1, now - Stats.lastFrameTime));
                Stats.lastFrameTime = now;
            }, 1000);
        },
        
        stopRuntimeTimer() {
            if (this.runtimeInterval) { clearInterval(this.runtimeInterval); this.runtimeInterval = null; }
        },
        
        async gameLoop() {
            while (this.isRunning && !this.shouldStop) {
                if (this.isPaused) {
                    await this.delay(100);
                    continue;
                }
                
                try {
                    if (GameReader.isVictory()) {
                        if (this.isPaused) continue;
                        const continueBtn = GameReader.getContinueButton();
                        if (continueBtn) {
                            Logger.info('🎉 达到 2048！点击继续游戏...');
                            continueBtn.click();
                            await this.delay(300);
                        }
                    }
                    
                    if (GameReader.isGameOver()) {
                        Logger.info('💀 游戏结束！已暂停，等待您决定是否开始新游戏');
                        this.pause();
                        break;
                    }
                    
                    if (this.isPaused) continue;
                    
                    const board = GameReader.getBoard();
                    const score = GameReader.getScore();
                    const maxTile = GameReader.getMaxTile(board);
                    
                    if (this.isPaused) continue;
                    
                    if (this.lastBoard && GameReader.boardEquals(board, this.lastBoard)) {
                        this.stuckCount++;
                        if (this.stuckCount >= CONFIG.STUCK_THRESHOLD) {
                            Logger.warn(`连续${this.stuckCount}步无变化，尝试打破僵局`);
                            const moves = BoardOperations.getAvailableMoves(board);
                            if (moves.length > 0) {
                                const randomMove = moves[Math.floor(Math.random() * moves.length)];
                                await MoveSender.sendMove(randomMove.direction);
                                this.moveCount++;
                                CycleDetector.add(board);
                                this.stuckCount = 0;
                                continue;
                            }
                        }
                    } else {
                        this.stuckCount = 0;
                    }
                    this.lastBoard = GameReader.cloneBoard(board);
                    
                    if (this.isPaused) continue;
                    
                    CycleDetector.add(board);
                    if (CycleDetector.isCycle()) {
                        Logger.warn('检测到循环移动，选择备选方案打破循环');
                        const fallback = await this.getBestMoveWithFallback(board);
                        this.currentMoveResult = fallback;
                        await MoveSender.sendMove(fallback.direction);
                        this.moveCount++;
                        CycleDetector.clear();
                        this.updateUI(board, score, maxTile, fallback);
                        continue;
                    }
                    
                    if (this.isPaused) continue;
                    
                    ControlPanel.setState('thinking');
                    const moveResult = Expectimax.getBestMove(board, () => this.isPaused);
                    ControlPanel.setState('running');
                    
                    if (this.isPaused) continue;
                    
                    if (!moveResult) {
                        await this.delay(100);
                        continue;
                    }
                    
                    if (this.isPaused) continue;
                    
                    this.currentMoveResult = moveResult;
                    await MoveSender.sendMove(moveResult.direction);
                    this.moveCount++;
                    
                    this.updateUI(board, score, maxTile, moveResult);
                    
                    Logger.log(
                        moveResult.direction, score, maxTile, moveResult.score,
                        moveResult.depth, moveResult.nodes, moveResult.time,
                        moveResult.phase, this.moveCount
                    );
                    
                    if (moveResult.timedOut) {
                        Logger.warn('搜索超时，返回当前最佳结果');
                    }
                    
                } catch (error) {
                    Logger.error(`游戏循环错误: ${error.message}\n${error.stack}`);
                    ControlPanel.setState('running');
                    await this.delay(500);
                }
            }
        },
        
        async getBestMoveWithFallback(board) {
            const moves = BoardOperations.getAvailableMoves(board);
            const phase = GamePhaseDetector.detectPhase(board);
            
            if (moves.length === 0) return null;
            
            moves.sort((a, b) => BoardEvaluator.evaluate(b.board, phase) - BoardEvaluator.evaluate(a.board, phase));
            
            return {
                direction: moves[Math.min(1, moves.length - 1)].direction,
                score: BoardEvaluator.evaluate(moves[Math.min(1, moves.length - 1)].board, phase),
                depth: 0, nodes: 1, time: 0, phase, timedOut: false
            };
        },
        
        updateUI(board, score, maxTile, moveResult) {
            ControlPanel.updateStats({
                score,
                maxTile,
                moves: this.moveCount,
                phase: moveResult.phase,
                chosenMove: moveResult.direction.toUpperCase(),
                evaluation: moveResult.score,
                depth: moveResult.depth,
                nodes: moveResult.nodes,
                searchTime: moveResult.time,
                avgTime: Stats.averageSearchTime,
                cacheHitRate: Stats.cacheHitRate,
                cacheSize: TranspositionTable.size,
                fps: Stats.fps
            });
        },
        
        delay(ms) { return new Promise(r => setTimeout(r, ms)); }
    };

    // ============================================
    // 主入口 - 带自动重试
    // ============================================
    async function main() {
        if (window.__ai2048Running) {
            Logger.info('清理已有AI实例...');
            if (window.__ai2048AutoPlayer) window.__ai2048AutoPlayer.stop();
            ControlPanel.destroy();
        }
        
        window.__ai2048Running = true;
        
        const gameLoaded = await GameReader.waitForDOM('.game-container', 5000);
        if (!gameLoaded) {
            Logger.error('未找到游戏容器，请确保在2048游戏页面运行此脚本');
            return;
        }
        
        AutoPlayer.init();
        window.__ai2048AutoPlayer = AutoPlayer;
        
        setTimeout(() => AutoPlayer.start(), 300);
    }

    console.log('%c🚀 2048 Advanced AI 加载中...', 'color: #8f7a66; font-size: 18px; font-weight: bold;');
    console.log('%c功能: Expectimax搜索 | 置换表缓存 | 自适应策略 | 循环检测 | 多维度评分', 'color: #776e65; font-size: 12px;');
    
    main();

})();
