import requests
from typing import Optional
import os
import chess.pgn
import random
from geo_server.model import GeoChess, ChessGame
from geo_server.sqlite_wrapper import SQLiteWrapper
from tqdm import tqdm


def parse_result(result: str):
    if result == "1-0":
        return 1
    elif result == "0-1":
        return 0
    else:
        return 0.5


def get_valid_tournament_ids():
    url = "https://lichess.org/api/tournament"
    response = requests.get(url)
    if response.status_code != 200:
        raise Exception(f"Failed to get valid tournament ids: {response.status_code}")
    data = response.json()
    ids = []
    for tournament in data["finished"]:
        if "variant" not in tournament or tournament["variant"]["key"] != "standard":
            continue
        if "position" in tournament:
            continue
        ids.append(tournament["id"])
    return ids


def get_games_from_tournament(tournament_id):
    os.makedirs("data/tournaments", exist_ok=True)
    url = f"https://lichess.org/api/tournament/{tournament_id}/games"
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        with open(f"data/tournaments/{tournament_id}.pgn", "wb") as f:
            for chunk in tqdm(r.iter_content(chunk_size=1 << 14)):
                if chunk:  # filter out keep-alive chunks
                    f.write(chunk)
    return f"data/tournaments/{tournament_id}.pgn"


def parse_games_from_pgn(pgn_file):
    with open(pgn_file, "r") as f:
        while True:
            pos = f.tell()
            game = chess.pgn.read_game(f)
            if game is None:
                break
            yield game


def count_games_from_pgn(pgn_file):
    with open(pgn_file, "r") as f:
        content = f.read()
        return content.count("\n\n\n")


def extract_fens_from_game(
    game: chess.pgn.Game,
    min_move: int = 5,
    max_move: Optional[int] = None,
):
    board = game.board()
    for move in game.mainline_moves():
        board.push(move)
        if board.fullmove_number < min_move:
            continue
        if max_move is not None and board.fullmove_number > max_move:
            break
        yield board


def simplify_fen(fen: str):
    fen = fen.split(" ")[0]
    for i in range(2, 9):
        fen = fen.replace(str(i), "1" * i)
    return fen


def cutout_random_subfen(fen: str, subfen_dims: tuple[int, int] = (3, 3)):
    fen = simplify_fen(fen)
    rows = fen.split("/")
    posx = random.randint(0, 8 - subfen_dims[0])
    posy = random.randint(0, 8 - subfen_dims[1])
    subfen = "/".join(
        [
            row[posx : posx + subfen_dims[0]]
            for row in rows[posy : posy + subfen_dims[1]]
        ]
    )
    return subfen, posx, posy


def score_subfen(geo_chess: GeoChess):
    subfen = geo_chess.subfen
    has_pawns = "p" in subfen or "P" in subfen
    has_pieces = any(c in subfen for c in "KQRBN")
    has_white = any(c in subfen for c in "KQRBNP")
    has_black = any(c in subfen for c in "kqrbnp")
    early_move = geo_chess.move_num < 15
    score = has_pawns + has_pieces + has_white + has_black + early_move
    geo_chess.score = score


def unsimplify_subfen(subfen: str):
    for i in range(9, 1, -1):
        subfen = subfen.replace("1" * i, str(i))
    return subfen


def create_and_store_geochess_from_pgn(
    pgn_file: str,
    sqlite_wrapper: SQLiteWrapper,
    dims: tuple = ((3, 3), (2, 4), (4, 2)),
    min_score: float = 4.0,
):
    for game in tqdm(
        parse_games_from_pgn(pgn_file),
        desc="Parsing games",
        total=count_games_from_pgn(pgn_file),
    ):
        chess_game = ChessGame(
            fen=game.board().fen(),
            result=parse_result(game.headers["Result"]),
            url=game.headers["Site"],
            whiteElo=game.headers["WhiteElo"],
            blackElo=game.headers["BlackElo"],
            timeControl=game.headers["TimeControl"],
            gameId=game.headers["GameId"],
        )
        for board in extract_fens_from_game(game):
            fen = board.fen()
            for dim in dims:
                subfen, posx, posy = cutout_random_subfen(fen, dim)
                geo_chess = GeoChess(
                    fen=fen,
                    subfen=unsimplify_subfen(subfen),
                    move_num=board.fullmove_number,
                    chess_game=chess_game,
                    posx=posx,
                    posy=posy,
                    dimx=dim[0],
                    dimy=dim[1],
                    last_move=str(board.move_stack[-1]),
                    white_to_move=board.turn == chess.WHITE,
                )
                score_subfen(geo_chess)
                if geo_chess.score >= min_score:
                    sqlite_wrapper.insert_geo_chess(geo_chess)


def add_geochess_to_database(sqlite_wrapper: SQLiteWrapper, n_tournaments: int = 10):
    i = 0
    for tournament_id in get_valid_tournament_ids():
        path = get_games_from_tournament(tournament_id)
        create_and_store_geochess_from_pgn(path, sqlite_wrapper)
        i += 1
        if i > n_tournaments:
            break


if __name__ == "__main__":
    sqlite_wrapper = SQLiteWrapper("database/geo_chess.db")
    sqlite_wrapper.reset_database()
    create_and_store_geochess_from_pgn("data/tournaments/8h042r8u.pgn", sqlite_wrapper)
