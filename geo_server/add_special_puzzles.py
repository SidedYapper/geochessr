from geo_server.sqlite_wrapper import SQLiteWrapper
from geo_server.model import GeoChess, ChessGame
from geo_server.get_new_positions import (
    extract_fens_from_game,
    cutout_subfen,
    score_subfen,
    compute_difficulty,
    get_chess_game_from_game,
)
import time
import chess.pgn
import json
import io
from typing import Optional
from sqlite3 import IntegrityError


def add_special_puzzles(
    sqlite_wrapper: SQLiteWrapper,
    dimx: int,
    dimy: int,
    posx: int,
    posy: int,
    half_move_num: int,
    game_id: Optional[str] = None,
    pgn: Optional[str] = None,
):
    if pgn:
        game = chess.pgn.read_game(io.StringIO(pgn))
        chess_game = get_chess_game_from_game(game)
        try:
            sqlite_wrapper.insert_chess_game(chess_game)
        except IntegrityError:
            pass
    else:
        assert game_id is not None
        chess_game = sqlite_wrapper.get_chess_game(game_id)
        game = chess.pgn.read_game(io.StringIO(chess_game.pgn))
    fullmove_num = half_move_num // 2 + 1
    white_to_move = half_move_num % 2 == 0
    boards = extract_fens_from_game(game, min_move=fullmove_num, max_move=fullmove_num)
    if not white_to_move:
        next(boards)
    board = next(boards)
    fen = board.fen()
    subfen = cutout_subfen(fen, posx, posy, (dimx, dimy))
    geo_chess = GeoChess(
        fen=fen,
        subfen=subfen,
        posx=posx,
        posy=posy,
        dimx=dimx,
        dimy=dimy,
        move_num=board.fullmove_number,
        chess_game=chess_game,
        white_to_move=white_to_move,
        timestamp_added=time.time(),
        last_move=str(board.move_stack[-1]),
    )
    score_subfen(geo_chess)
    compute_difficulty(geo_chess)
    sqlite_wrapper.insert_geo_chess(geo_chess)


if __name__ == "__main__":
    sqlite_wrapper = SQLiteWrapper("database/geo_chess.db")
    with open("data/special_puzzles/specials.json", "r") as f:
        specials = json.load(f)
    for special in specials:
        add_special_puzzles(sqlite_wrapper, **specials[special])
