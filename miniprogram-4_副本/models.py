"""SQLAlchemy 模型定义（面向多租户的 B2B 移民中介 CRM）。"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    """SQLAlchemy 基类。"""


class TimestampMixin:
    """公共时间戳字段。"""

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )


class Agency(Base, TimestampMixin):
    """中介公司（租户）。"""

    __tablename__ = "agencies"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)

    clients: Mapped[list[Client]] = relationship(
        "Client", back_populates="agency", cascade="all, delete-orphan"
    )
    cases: Mapped[list[Case]] = relationship(
        "Case", back_populates="agency", cascade="all, delete-orphan"
    )
    statuses: Mapped[list[Status]] = relationship(
        "Status", back_populates="agency", cascade="all, delete-orphan"
    )


class Client(Base, TimestampMixin):
    """客户信息。"""

    __tablename__ = "clients"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    agency_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agencies.id", ondelete="CASCADE"), nullable=False
    )
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    passport_number: Mapped[str] = mapped_column(String(64), nullable=False)
    date_of_birth: Mapped[date] = mapped_column(Date, nullable=False)

    # 关键逻辑：客户必须归属某个租户，确保多租户隔离
    agency: Mapped[Agency] = relationship("Agency", back_populates="clients")
    cases: Mapped[list[Case]] = relationship(
        "Case", back_populates="client", cascade="all, delete-orphan"
    )

    __table_args__ = (
        # 同一租户下护照号唯一，避免重复客户
        Index("ix_clients_agency_passport", "agency_id", "passport_number", unique=True),
    )


class Status(Base, TimestampMixin):
    """案件状态（可按租户自定义）。"""

    __tablename__ = "statuses"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    agency_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agencies.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_terminal: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # 关键逻辑：状态归属租户，避免跨租户复用
    agency: Mapped[Agency] = relationship("Agency", back_populates="statuses")
    cases: Mapped[list[Case]] = relationship("Case", back_populates="status")

    __table_args__ = (
        Index("ix_statuses_agency_name", "agency_id", "name", unique=True),
    )


class Case(Base, TimestampMixin):
    """案件信息。"""

    __tablename__ = "cases"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    agency_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agencies.id", ondelete="CASCADE"), nullable=False
    )
    client_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("clients.id", ondelete="CASCADE"), nullable=False
    )
    status_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("statuses.id", ondelete="SET NULL"), nullable=True
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    case_type: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # 关键逻辑：案件归属租户与客户，确保多租户隔离
    agency: Mapped[Agency] = relationship("Agency", back_populates="cases")
    client: Mapped[Client] = relationship("Client", back_populates="cases")
    status: Mapped[Status | None] = relationship("Status", back_populates="cases")
    documents: Mapped[list[Document]] = relationship(
        "Document", back_populates="case", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("ix_cases_agency_client", "agency_id", "client_id"),
        Index("ix_cases_agency_status", "agency_id", "status_id"),
    )


class Document(Base, TimestampMixin):
    """案件相关文档元数据。"""

    __tablename__ = "documents"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    agency_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agencies.id", ondelete="CASCADE"), nullable=False
    )
    case_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cases.id", ondelete="CASCADE"), nullable=False
    )
    document_type: Mapped[str] = mapped_column(String(100), nullable=False)
    storage_path: Mapped[str] = mapped_column(String(512), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(100), nullable=True)

    # 关键逻辑：只保存文件元数据，避免在数据库存储敏感内容
    case: Mapped[Case] = relationship("Case", back_populates="documents")

    __table_args__ = (
        Index("ix_documents_agency_case", "agency_id", "case_id"),
    )
