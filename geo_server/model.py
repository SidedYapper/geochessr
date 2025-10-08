from pydantic import BaseModel, Field
from typing import Optional


class ChessGame(BaseModel):
    result: float
    whiteElo: int
    blackElo: int
    timeControl: str
    gameId: Optional[str] = None
    url: Optional[str] = None
    year: Optional[int] = None
    eco: Optional[str] = None
    whitePlayer: Optional[str] = None
    blackPlayer: Optional[str] = None
    source: Optional[str] = None
    pgn: Optional[str] = None


class GeoChess(BaseModel):
    fen: str
    subfen: str
    posx: int
    posy: int
    dimx: int
    dimy: int
    move_num: int
    last_move: str
    chess_game: ChessGame
    white_to_move: bool
    successes: int = 0
    fails: int = 0
    id: Optional[int] = None
    score: Optional[float] = None
    difficulty: Optional[float] = None
    timestamp_added: Optional[float] = None


class Run(BaseModel):
    identifier: str
    puzzle_ids: list[int]
    is_daily: bool
    black_info_rate: float
    metadata_fields: list[str]
    completed_count: int = 0
    avg_time_seconds: Optional[float] = None
    avg_correct_count: Optional[float] = None


class RunSettings(BaseModel):
    metadata_fields: Optional[list[str]] = None
    min_difficulty: Optional[float] = None
    max_difficulty: Optional[float] = None
    min_difficulty_percentage: Optional[float] = None
    max_difficulty_percentage: Optional[float] = None
    min_score: float = 5.0
    n_puzzles: int = 5
    max_played: Optional[int] = None
    early_timestamp: Optional[int] = None
    late_timestamp: Optional[int] = None
    min_move_num: Optional[int] = None
    max_move_num: Optional[int] = None
    black_info_rate: float = 0.0
    source: Optional[str] = None
