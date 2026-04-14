from typing import Optional
from .models import User
from .database import get_session

MAX_RETRIES = 3
API_VERSION = "2.0"

class UserService:
    """Service for user management"""

    def __init__(self, db_url: str):
        self.db_url = db_url
        self.session = get_session(db_url)

    def find_by_email(self, email: str) -> Optional[User]:
        """Find user by email address"""
        return self.session.query(User).filter_by(email=email).first()

    def create_user(self, email: str, name: str) -> User:
        user = User(email=email, name=name)
        self.session.add(user)
        self.session.commit()
        return user

    @staticmethod
    def validate_email(email: str) -> bool:
        return "@" in email

def authenticate(email: str, password: str) -> Optional[User]:
    """Authenticate user with credentials"""
    service = UserService("sqlite:///db.sqlite")
    user = service.find_by_email(email)
    if user and _verify_password(user, password):
        return user
    return None

def _verify_password(user: User, password: str) -> bool:
    return user.password_hash == _hash(password)

def _hash(value: str) -> str:
    return value
