import sqlite3
from geo_server.model import GeoChess, ChessGame


class SQLiteWrapper:
    def __init__(self, db_path: str):
        self.conn = sqlite3.connect(db_path)
        self.initialize_tables()

    def reset_database(self):
        self.conn.execute("DROP TABLE IF EXISTS geo_chess")
        self.conn.execute("DROP TABLE IF EXISTS chess_games")
        self.initialize_tables()
        self.conn.commit()

    def initialize_tables(self):
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS geo_chess (id INTEGER PRIMARY KEY AUTOINCREMENT, fen TEXT, subfen TEXT, posx INTEGER, posy INTEGER, dimx INTEGER, dimy INTEGER, move_num INTEGER, last_move TEXT, gameId TEXT, white_to_move INTEGER, score REAL, played INTEGER)"
        )
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS chess_games (result REAL, url TEXT, whiteElo INTEGER, blackElo INTEGER, timeControl TEXT, gameId TEXT PRIMARY KEY)"
        )
        self.conn.commit()

    def insert_geo_chess(self, geo_chess: GeoChess):
        self.conn.execute(
            "INSERT INTO geo_chess (fen, subfen, posx, posy, dimx, dimy, move_num, last_move, gameId, white_to_move, score, played) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                geo_chess.white_to_move,
                geo_chess.score,
                geo_chess.played,
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
            "INSERT INTO chess_games (result, url, whiteElo, blackElo, timeControl, gameId) VALUES (?, ?, ?, ?, ?, ?)",
            (
                chess_game.result,
                chess_game.url,
                chess_game.whiteElo,
                chess_game.blackElo,
                chess_game.timeControl,
                chess_game.gameId,
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
        )

    def get_geo_chess(self, id: int):
        cursor = self.conn.execute("SELECT * FROM geo_chess WHERE id = ?", (id,))
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
            played=result[12],
        )

    def get_random_geo_chess(self):
        cursor = self.conn.execute(
            "SELECT id, fen, subfen, posx, posy, dimx, dimy, move_num, last_move, gameId, white_to_move, score, played FROM geo_chess ORDER BY RANDOM() LIMIT 1"
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
            played=result[12],
        )
