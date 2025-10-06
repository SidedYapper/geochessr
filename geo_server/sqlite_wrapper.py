import sqlite3
from geo_server.model import GeoChess, ChessGame, RunSettings, Run


class SQLiteWrapper:
    def __init__(self, db_path: str):
        self.conn = sqlite3.connect(db_path)
        self.initialize_tables()

    def reset_database(self):
        self.conn.execute("DROP TABLE IF EXISTS geo_chess")
        self.conn.execute("DROP TABLE IF EXISTS chess_games")
        self.conn.execute("DROP TABLE IF EXISTS runs")
        self.conn.execute("DROP TABLE IF EXISTS run_puzzles")
        self.initialize_tables()
        self.conn.commit()

    def reset_runs(self):
        self.conn.execute("DROP TABLE IF EXISTS runs")
        self.conn.execute("DROP TABLE IF EXISTS run_puzzles")
        self.initialize_tables()
        self.conn.commit()

    def initialize_tables(self):
        # New schema: drop legacy 'played', add successes, fails, timestamp_added (unix seconds)
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS geo_chess (id INTEGER PRIMARY KEY AUTOINCREMENT, fen TEXT, subfen TEXT, posx INTEGER, posy INTEGER, dimx INTEGER, dimy INTEGER, move_num INTEGER, last_move TEXT, gameId TEXT, white_to_move INTEGER, score REAL, difficulty REAL, successes INTEGER DEFAULT 0, fails INTEGER DEFAULT 0, timestamp_added REAL)"
        )
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS chess_games (result REAL, url TEXT, whiteElo INTEGER, blackElo INTEGER, timeControl TEXT, gameId TEXT PRIMARY KEY, eco TEXT, whitePlayer TEXT, blackPlayer TEXT, source TEXT, year INTEGER, pgn TEXT)"
        )
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS runs (identifier TEXT PRIMARY KEY, is_daily INTEGER, black_info_rate REAL, metadata_fields TEXT)"
        )
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS run_puzzles (run_id TEXT, puzzle_id INTEGER, PRIMARY KEY (run_id, puzzle_id))"
        )
        self.conn.commit()

    def insert_geo_chess(self, geo_chess: GeoChess):
        self.conn.execute(
            "INSERT INTO geo_chess (fen, subfen, posx, posy, dimx, dimy, move_num, last_move, gameId, white_to_move, score, difficulty, successes, fails, timestamp_added) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                geo_chess.fen,
                geo_chess.subfen,
                geo_chess.posx,
                geo_chess.posy,
                geo_chess.dimx,
                geo_chess.dimy,
                geo_chess.move_num,
                geo_chess.last_move,
                geo_chess.chess_game.gameId,
                1 if bool(geo_chess.white_to_move) else 0,
                geo_chess.score,
                geo_chess.difficulty,
                int(getattr(geo_chess, "successes", 0) or 0),
                int(getattr(geo_chess, "fails", 0) or 0),
                int(getattr(geo_chess, "timestamp_added", 0) or 0),
            ),
        )
        # Check if the chess_game already exists in the chess_games table
        cursor = self.conn.execute(
            "SELECT 1 FROM chess_games WHERE gameId = ?", (geo_chess.chess_game.gameId,)
        )
        if cursor.fetchone() is None:
            self.insert_chess_game(geo_chess.chess_game)
        self.conn.commit()

    def insert_chess_game(self, chess_game: ChessGame):
        self.conn.execute(
            "INSERT INTO chess_games (result, url, whiteElo, blackElo, timeControl, gameId, eco, whitePlayer, blackPlayer, source, year, pgn) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                chess_game.result,
                chess_game.url,
                chess_game.whiteElo,
                chess_game.blackElo,
                chess_game.timeControl,
                chess_game.gameId,
                chess_game.eco,
                chess_game.whitePlayer,
                chess_game.blackPlayer,
                chess_game.source,
                chess_game.year,
                chess_game.pgn,
            ),
        )
        self.conn.commit()

    def get_chess_game(self, gameId: str):
        cursor = self.conn.execute(
            "SELECT * FROM chess_games WHERE gameId = ?", (gameId,)
        )
        result = cursor.fetchone()
        if result is None:
            return None
        return ChessGame(
            result=result[0],
            url=result[1],
            whiteElo=result[2],
            blackElo=result[3],
            timeControl=result[4],
            gameId=result[5],
            eco=result[6],
            whitePlayer=result[7],
            blackPlayer=result[8],
            source=result[9],
            year=result[10],
            pgn=result[11],
        )

    def get_geo_chess(self, id: int):
        cursor = self.conn.execute(
            "SELECT id, fen, subfen, posx, posy, dimx, dimy, move_num, last_move, gameId, white_to_move, score, difficulty, successes, fails, timestamp_added FROM geo_chess WHERE id = ?",
            (id,),
        )
        result = cursor.fetchone()
        if result is None:
            return None

        chess_game = self.get_chess_game(result[9])
        return GeoChess(
            id=result[0],
            fen=result[1],
            subfen=result[2],
            posx=result[3],
            posy=result[4],
            dimx=result[5],
            dimy=result[6],
            move_num=result[7],
            last_move=result[8],
            chess_game=chess_game,
            white_to_move=bool(result[10]),
            score=result[11],
            difficulty=result[12],
            successes=result[13],
            fails=result[14],
            timestamp_added=result[15],
        )

    def select_geo_chess_for_run(self, run_settings: RunSettings) -> list[GeoChess]:
        # Build base filters (exclude percentile handling for now)
        where_clauses = []
        params = []

        # Score constraint
        if run_settings.min_score is not None:
            where_clauses.append("score >= ?")
            params.append(run_settings.min_score)

        # Move number constraints
        if run_settings.min_move_num is not None:
            where_clauses.append("move_num >= ?")
            params.append(run_settings.min_move_num)
        if run_settings.max_move_num is not None:
            where_clauses.append("move_num <= ?")
            params.append(run_settings.max_move_num)

        # Played constraint based on attempts = successes + fails
        if run_settings.max_played is not None:
            where_clauses.append("(IFNULL(successes, 0) + IFNULL(fails, 0)) <= ?")
            params.append(run_settings.max_played)

        # Timestamp constraints
        if run_settings.early_timestamp is not None:
            where_clauses.append("IFNULL(timestamp_added, 0) >= ?")
            params.append(run_settings.early_timestamp)
        if run_settings.late_timestamp is not None:
            where_clauses.append("IFNULL(timestamp_added, 0) <= ?")
            params.append(run_settings.late_timestamp)

        # Difficulty absolute constraints (used in both queries)
        if run_settings.min_difficulty is not None:
            where_clauses.append("difficulty >= ?")
            params.append(run_settings.min_difficulty)
        if run_settings.max_difficulty is not None:
            where_clauses.append("difficulty <= ?")
            params.append(run_settings.max_difficulty)

        base_where_sql = (
            (" WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
        )

        # Determine if percentile-based difficulty bounds are requested
        has_min_pct = run_settings.min_difficulty_percentage is not None
        has_max_pct = run_settings.max_difficulty_percentage is not None

        percentile_bounds = None
        if has_min_pct or has_max_pct:
            # First query: collect difficulties matching other constraints
            # Join to chess_games to allow source filtering later; but for difficulty sampling we don't need join
            diff_query = (
                f"SELECT difficulty FROM geo_chess{base_where_sql} AND difficulty IS NOT NULL"
                if base_where_sql
                else "SELECT difficulty FROM geo_chess WHERE difficulty IS NOT NULL"
            )
            cursor = self.conn.execute(diff_query, tuple(params))
            diffs = [row[0] for row in cursor.fetchall() if row[0] is not None]
            if not diffs:
                return []

            diffs.sort()
            n = len(diffs)

            # Normalize percentage values: allow 0-1 or 0-100
            def normalize_pct(p):
                if p is None:
                    return None
                try:
                    val = float(p)
                except Exception:
                    return None
                return val / 100.0 if val > 1.0 else val

            min_pct = normalize_pct(run_settings.min_difficulty_percentage)
            max_pct = normalize_pct(run_settings.max_difficulty_percentage)
            if min_pct is None:
                min_pct = 0.0
            if max_pct is None:
                max_pct = 1.0
            # Clamp
            min_pct = max(0.0, min(1.0, min_pct))
            max_pct = max(0.0, min(1.0, max_pct))
            if min_pct > max_pct:
                # No possible results
                return []

            # Compute inclusive indices within sorted array
            import math

            low_idx = int(math.floor(min_pct * (n - 1)))
            high_idx = int(math.floor(max_pct * (n - 1)))
            low_idx = max(0, min(n - 1, low_idx))
            high_idx = max(0, min(n - 1, high_idx))
            low_bound = diffs[low_idx]
            high_bound = diffs[high_idx]
            percentile_bounds = (low_bound, high_bound)

        # Final selection query
        final_where_clauses = list(where_clauses)
        final_params = list(params)
        if percentile_bounds is not None:
            final_where_clauses.append("difficulty >= ?")
            final_params.append(percentile_bounds[0])
            final_where_clauses.append("difficulty <= ?")
            final_params.append(percentile_bounds[1])

        # Optional source filter joins geo_chess to chess_games on gameId
        join_sql = ""
        if getattr(run_settings, "source", None):
            join_sql = " JOIN chess_games cg ON cg.gameId = geo_chess.gameId"
            final_where_clauses.append("cg.source = ?")
            final_params.append(run_settings.source)

        final_where_sql = (
            (" WHERE " + " AND ".join(final_where_clauses))
            if final_where_clauses
            else ""
        )

        limit = int(
            (run_settings.n_puzzles if run_settings.n_puzzles is not None else 5) or 5
        )
        select_sql = (
            "SELECT geo_chess.id, geo_chess.fen, geo_chess.subfen, geo_chess.posx, geo_chess.posy, geo_chess.dimx, geo_chess.dimy, geo_chess.move_num, geo_chess.last_move, geo_chess.gameId, geo_chess.white_to_move, geo_chess.score, geo_chess.difficulty, geo_chess.successes, geo_chess.fails, geo_chess.timestamp_added "
            f"FROM geo_chess{join_sql}{final_where_sql} ORDER BY RANDOM() LIMIT {limit}"
        )
        cursor = self.conn.execute(select_sql, tuple(final_params))
        rows = cursor.fetchall()

        result = []
        for row in rows:
            chess_game = self.get_chess_game(row[9])
            result.append(
                GeoChess(
                    id=row[0],
                    fen=row[1],
                    subfen=row[2],
                    posx=row[3],
                    posy=row[4],
                    dimx=row[5],
                    dimy=row[6],
                    move_num=row[7],
                    last_move=row[8],
                    chess_game=chess_game,
                    white_to_move=bool(row[10]),
                    score=row[11],
                    difficulty=row[12],
                    successes=row[13],
                    fails=row[14],
                    timestamp_added=row[15],
                )
            )
        return result

    def get_random_geo_chess(self):
        cursor = self.conn.execute(
            "SELECT id, fen, subfen, posx, posy, dimx, dimy, move_num, last_move, gameId, white_to_move, score, difficulty, successes, fails, timestamp_added FROM geo_chess ORDER BY RANDOM() LIMIT 1"
        )
        result = cursor.fetchone()
        if result is None:
            return None

        chess_game = self.get_chess_game(result[9])
        return GeoChess(
            id=result[0],
            fen=result[1],
            subfen=result[2],
            posx=result[3],
            posy=result[4],
            dimx=result[5],
            dimy=result[6],
            move_num=result[7],
            last_move=result[8],
            chess_game=chess_game,
            white_to_move=bool(result[10]),
            score=result[11],
            difficulty=result[12],
            successes=result[13],
            fails=result[14],
            timestamp_added=result[15],
        )

    def insert_run(self, run: Run):
        self.conn.execute(
            "INSERT INTO runs (identifier, is_daily, black_info_rate, metadata_fields) VALUES (?, ?, ?, ?)",
            (
                run.identifier,
                run.is_daily,
                run.black_info_rate,
                ",".join(run.metadata_fields),
            ),
        )
        for puzzle_id in run.puzzle_ids:
            self.conn.execute(
                "INSERT INTO run_puzzles (run_id, puzzle_id) VALUES (?, ?)",
                (run.identifier, puzzle_id),
            )
        self.conn.commit()

    def get_run(self, identifier: str) -> Run:
        cursor = self.conn.execute(
            "SELECT identifier, is_daily, black_info_rate, metadata_fields FROM runs WHERE identifier = ?",
            (identifier,),
        )
        result = cursor.fetchone()
        print("Result", result)
        if result is None:
            return None
        cursor = self.conn.execute(
            "SELECT puzzle_id FROM run_puzzles WHERE run_id = ?",
            (identifier,),
        )
        puzzle_ids = [row[0] for row in cursor.fetchall()]
        return Run(
            identifier=result[0],
            is_daily=result[1],
            black_info_rate=result[2],
            puzzle_ids=puzzle_ids,
            metadata_fields=result[3].split(","),
        )

    def get_daily_run(self) -> Run:
        cursor = self.conn.execute(
            "SELECT identifier, is_daily, black_info_rate, metadata_fields FROM runs WHERE is_daily = 1",
        )
        result = cursor.fetchone()
        if result is None:
            return None
        cursor = self.conn.execute(
            "SELECT puzzle_id FROM run_puzzles WHERE run_id = ?",
            (result[0],),
        )
        puzzle_ids = [row[0] for row in cursor.fetchall()]
        return Run(
            identifier=result[0],
            is_daily=result[1],
            black_info_rate=result[2],
            puzzle_ids=puzzle_ids,
            metadata_fields=result[3].split(","),
        )

    def remove_daily_run(self):
        self.conn.execute("UPDATE runs SET is_daily = 0 WHERE is_daily = 1")
        self.conn.commit()
