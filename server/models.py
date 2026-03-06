"""SQLAlchemy models for LDA filings storage."""
import datetime
from sqlalchemy import (
    Column, String, Integer, Float, Text, DateTime, Boolean,
    ForeignKey, Table, create_engine, Index
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker

Base = declarative_base()


class Registrant(Base):
    __tablename__ = "registrants"

    id = Column(Integer, primary_key=True)
    senate_id = Column(Integer, unique=True, nullable=False, index=True)
    name = Column(String(500), nullable=False, index=True)
    description = Column(Text)
    address = Column(String(500))
    country = Column(String(200))
    state = Column(String(100))

    filings = relationship("Filing", back_populates="registrant")


class Client(Base):
    __tablename__ = "clients"

    id = Column(Integer, primary_key=True)
    senate_id = Column(Integer, unique=True, nullable=False, index=True)
    name = Column(String(500), nullable=False, index=True)
    description = Column(Text)
    country = Column(String(200))
    state = Column(String(100))

    filings = relationship("Filing", back_populates="client")


class Filing(Base):
    __tablename__ = "filings"

    id = Column(Integer, primary_key=True)
    filing_uuid = Column(String(36), unique=True, nullable=False, index=True)
    filing_type = Column(String(50), index=True)
    filing_type_display = Column(String(200))
    filing_year = Column(Integer, index=True)
    filing_period = Column(String(50), index=True)
    filing_period_display = Column(String(200))
    filing_date = Column(DateTime, index=True)
    dt_posted = Column(DateTime, index=True)
    income = Column(Float)
    expenses = Column(Float)
    expenses_method = Column(String(100))
    expenses_method_display = Column(String(200))
    posted_by_name = Column(String(300))
    url = Column(String(500))

    registrant_id = Column(Integer, ForeignKey("registrants.id"), index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), index=True)

    registrant = relationship("Registrant", back_populates="filings")
    client = relationship("Client", back_populates="filings")
    lobbying_activities = relationship("LobbyingActivity", back_populates="filing", cascade="all, delete-orphan")

    __table_args__ = (
        Index("ix_filings_year_period", "filing_year", "filing_period"),
        Index("ix_filings_dt_posted_desc", dt_posted.desc()),
    )


class LobbyingActivity(Base):
    __tablename__ = "lobbying_activities"

    id = Column(Integer, primary_key=True)
    filing_id = Column(Integer, ForeignKey("filings.id", ondelete="CASCADE"), nullable=False, index=True)
    general_issue_code = Column(String(10), index=True)
    general_issue_code_display = Column(String(200), index=True)
    description = Column(Text)
    specific_issues = Column(Text)
    government_entities = Column(Text)  # stored as JSON string
    lobbyists = Column(Text)  # stored as JSON string

    filing = relationship("Filing", back_populates="lobbying_activities")


# Full-text search virtual table will be created separately


def get_engine(db_path="lda_filings.db"):
    engine = create_engine(f"sqlite:///{db_path}", echo=False)
    return engine


def init_db(db_path="lda_filings.db"):
    engine = get_engine(db_path)
    Base.metadata.create_all(engine)

    # Create FTS5 virtual table for full-text search
    with engine.connect() as conn:
        conn.execute(
            __import__("sqlalchemy").text(
                """
                CREATE VIRTUAL TABLE IF NOT EXISTS filings_fts USING fts5(
                    filing_uuid,
                    registrant_name,
                    client_name,
                    issue_codes,
                    specific_issues,
                    description,
                    government_entities,
                    lobbyist_names,
                    content='',
                    tokenize='porter unicode61'
                )
                """
            )
        )
        conn.commit()

    return engine


def get_session(engine):
    Session = sessionmaker(bind=engine)
    return Session()
