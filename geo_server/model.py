from pydantic import BaseModel
from typing import Optional


class ChessGame(BaseModel):
    result: float
    url: str
    whiteElo: int
    blackElo: int
    timeControl: str
    gameId: str


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
    played: int = 0
    id: Optional[int] = None
    score: Optional[float] = None
