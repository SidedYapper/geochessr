import requests
import hashlib
from functools import reduce
from operator import mul
from typing import Optional
import os
import chess.pgn
import random
from geo_server.model import GeoChess, ChessGame
from geo_server.sqlite_wrapper import SQLiteWrapper
import secrets
import string
from tqdm import tqdm
import time

og_fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


def parse_result(result: str):
    if result == "1-0":
        return 1
    elif result == "0-1":
        return 0
    else:
        return 0.5


def parse_move(move: str) -> tuple[tuple[int, int], tuple[int, int]]:
    letters = "abcdefgh"
    return (letters.index(move[0]) + 1, int(move[1])), (
        letters.index(move[2]) + 1,
        int(move[3]),
    )


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
        if (
            not "clock" in tournament
            or not "limit" in tournament["clock"]
            or tournament["clock"]["limit"] <= 60
        ):
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
    with open(pgn_file, "r", encoding="utf-8", errors="replace") as f:
        while True:
            pos = f.tell()
            game = chess.pgn.read_game(f)
            if game is None:
                break
            yield game


def count_games_from_pgn(pgn_file):
    with open(pgn_file, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()
        return content.count("[Event")


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


def cutout_subfen(
    fen: str, posx: int, posy: int, subfen_dims: tuple[int, int] = (3, 3)
):
    fen = simplify_fen(fen)
    rows = fen.split("/")
    subfen = "/".join(
        [
            row[posx : posx + subfen_dims[0]]
            for row in rows[posy : posy + subfen_dims[1]]
        ]
    )
    return subfen


def cutout_random_subfen(fen: str, subfen_dims: tuple[int, int] = (3, 3)):
    posx = random.randint(0, 8 - subfen_dims[0])
    posy = random.randint(0, 8 - subfen_dims[1])
    return cutout_subfen(fen, posx, posy, subfen_dims), posx, posy


def compute_subfen_stats(geo_chess: GeoChess):
    stats = {}
    subfen = geo_chess.subfen
    last_move = parse_move(geo_chess.last_move)

    stats["white_pawn_count"] = subfen.count("P")
    stats["black_pawn_count"] = subfen.count("p")
    stats["pawn_count"] = stats["white_pawn_count"] + stats["black_pawn_count"]
    stats["white_piece_count"] = sum(c in "KQRBN" for c in subfen)
    stats["black_piece_count"] = sum(c in "kqrbn" for c in subfen)
    stats["white_count"] = stats["white_piece_count"] + stats["white_pawn_count"]
    stats["black_count"] = stats["black_piece_count"] + stats["black_pawn_count"]
    stats["piece_count"] = stats["white_piece_count"] + stats["black_piece_count"]
    stats["piece_pawn_count"] = stats["white_count"] + stats["black_count"]
    stats["king_count"] = subfen.count("K") + subfen.count("k")

    corrected_posy = 8 - geo_chess.posy
    corrected_posx = geo_chess.posx + 1
    stats["last_move_in_subfen"] = any(
        [
            corrected_posx <= x < corrected_posx + geo_chess.dimx
            and corrected_posy - geo_chess.dimy < y <= corrected_posy
            for x, y in last_move
        ]
    )
    og_cutout = cutout_subfen(
        og_fen, geo_chess.posx, geo_chess.posy, (geo_chess.dimx, geo_chess.dimy)
    )
    simple_og = simplify_fen(og_cutout)
    simple_subfen = simplify_fen(subfen)
    stats["unmoved_piece_pawn_count"] = sum(
        1 for i in range(len(simple_og)) if simple_og[i] == simple_subfen[i]
    )
    stats["moved_piece_pawn_count"] = (
        stats["piece_pawn_count"] - stats["unmoved_piece_pawn_count"]
    )
    return stats


def compute_difficulty(geo_chess: GeoChess):
    stats = compute_subfen_stats(geo_chess)
    difficulty = (
        -stats["pawn_count"]
        - stats["piece_count"]
        - stats["unmoved_piece_pawn_count"]
        - stats["last_move_in_subfen"]
        - geo_chess.dimx * geo_chess.dimy
        - int(stats["king_count"] > 0) * 2
        + geo_chess.move_num // 8
    )
    geo_chess.difficulty = difficulty


def score_subfen(geo_chess: GeoChess):
    stats = compute_subfen_stats(geo_chess)
    early_move = geo_chess.move_num < 15
    score = (
        early_move
        + stats["last_move_in_subfen"]
        + (stats["moved_piece_pawn_count"] > 1)
        + (stats["pawn_count"] > 0)
        + (stats["white_count"] > 0)
        + (stats["black_count"] > 0)
        + (stats["piece_count"] > 0)
        - (stats["king_count"] > 0)
        - (stats["unmoved_piece_pawn_count"] > 2)
    )

    geo_chess.score = score


def unsimplify_subfen(subfen: str):
    for i in range(9, 1, -1):
        subfen = subfen.replace("1" * i, str(i))
    return subfen


def get_chess_game_from_game(game: chess.pgn.Game, source: str = "lichess"):
    def compute_game_id_from_headers(headers):
        # Use a tuple of relevant fields to create a deterministic hash
        relevant_fields = (
            headers.get("Result", ""),
            headers.get("Site", ""),
            headers.get("WhiteElo", ""),
            headers.get("BlackElo", ""),
            headers.get("TimeControl", ""),
            headers.get("ECO", ""),
            headers.get("White", ""),
            headers.get("Black", ""),
            headers.get("Date", ""),
        )
        hash_input = "|".join(str(f) for f in relevant_fields)
        return hashlib.sha256(hash_input.encode("utf-8")).hexdigest()[:16]

    return ChessGame(
        result=parse_result(game.headers["Result"]),
        url=game.headers["Site"],
        whiteElo=(
            game.headers["WhiteElo"]
            if ("WhiteElo" in game.headers and game.headers["WhiteElo"].isdigit())
            else 0
        ),
        blackElo=(
            game.headers["BlackElo"]
            if ("BlackElo" in game.headers and game.headers["BlackElo"].isdigit())
            else 0
        ),
        timeControl=(
            game.headers["TimeControl"] if "TimeControl" in game.headers else "Unknown"
        ),
        gameId=(
            game.headers["GameId"]
            if "GameId" in game.headers
            else compute_game_id_from_headers(game.headers)
        ),
        eco=game.headers["ECO"] if "ECO" in game.headers else None,
        whitePlayer=game.headers["White"],
        blackPlayer=game.headers["Black"],
        source=source,
        pgn=str(game),
        year=(
            int(game.headers["Date"].split(".")[0])
            if ("Date" in game.headers and game.headers["Date"].split(".")[0].isdigit())
            else None
        ),
    )


def create_and_store_geochess_from_pgn(
    pgn_file: str,
    sqlite_wrapper: SQLiteWrapper,
    dims: tuple = ((3, 3), (2, 4), (4, 2), (3, 2), (2, 3)),
    min_score: float = 5.0,
    rate: float = 0.1,
    source: str = "lichess",
):
    for game in tqdm(
        parse_games_from_pgn(pgn_file),
        desc="Parsing games",
        total=count_games_from_pgn(pgn_file),
    ):
        chess_game = get_chess_game_from_game(game, source)
        if (
            chess_game.eco is None
            or chess_game.whitePlayer == "?"
            or chess_game.blackPlayer == "?"
        ):
            continue
        for board in extract_fens_from_game(game):
            fen = board.fen()
            for dim in dims:
                if random.random() > rate:
                    continue
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
                    timestamp_added=time.time(),
                )
                score_subfen(geo_chess)
                if geo_chess.score >= min_score:
                    compute_difficulty(geo_chess)
                    sqlite_wrapper.insert_geo_chess(geo_chess)


def add_geochess_to_database(sqlite_wrapper: SQLiteWrapper, n_tournaments: int = 10):
    i = 0
    for tournament_id in get_valid_tournament_ids():
        path = get_games_from_tournament(tournament_id)
        create_and_store_geochess_from_pgn(path, sqlite_wrapper)
        i += 1
        if i >= n_tournaments:
            break


def store_the_world_champion_games(sqlite_wrapper: SQLiteWrapper):
    pgns_path = "data/world_champion_games"
    for pgn_file in tqdm(os.listdir(pgns_path), desc="Parsing world champions"):
        create_and_store_geochess_from_pgn(
            os.path.join(pgns_path, pgn_file), sqlite_wrapper, source="world_champion"
        )


if __name__ == "__main__":
    sqlite_wrapper = SQLiteWrapper("database/geo_chess.db")
    sqlite_wrapper.reset_database()
    store_the_world_champion_games(sqlite_wrapper)
    for f in tqdm(os.listdir("data/tournaments"), desc="Parsing lichess tournaments"):
        create_and_store_geochess_from_pgn(
            os.path.join("data/tournaments", f), sqlite_wrapper
        )
    add_geochess_to_database(sqlite_wrapper)
